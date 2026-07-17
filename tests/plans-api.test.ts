import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../server/app.js';
import { openDatabase, type Database } from '../server/db.js';

let database: Database;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  database = await openDatabase(':memory:');
  app = await createApp({ database, cookieSecure: false, serveStatic: false });
});

afterEach(async () => {
  await database.close();
});

async function setupAdmin() {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/auth/setup')
    .send({ password: 'Admin setup password!' })
    .expect(201);
  return { agent, user: response.body.data.user as { id: number } };
}

async function inviteAndActivate(
  admin: ReturnType<typeof request.agent>,
  username: string,
  password = `${username} secure password!`,
) {
  const invitation = await admin
    .post('/api/admin/users')
    .send({ username, role: 'user' })
    .expect(201);
  const agent = request.agent(app);
  const activation = await agent
    .post('/api/auth/activate')
    .send({ username, inviteCode: invitation.body.data.inviteCode, newPassword: password })
    .expect(200);
  return { agent, user: activation.body.data.user as { id: number; username: string } };
}

describe('weekly workout plan', () => {
  it('requires authentication and seeds seven independent rest days per user', async () => {
    await request(app).get('/api/workout-plan').expect(401);
    const { agent: admin } = await setupAdmin();
    const member = await inviteAndActivate(admin, 'Member');

    const adminPlan = await admin.get('/api/workout-plan').expect(200);
    const memberPlan = await member.agent.get('/api/workout-plan').expect(200);
    for (const plan of [adminPlan, memberPlan]) {
      expect(plan.body.data.days).toHaveLength(7);
      expect(plan.body.data.days.map((day: { dayOfWeek: number }) => day.dayOfWeek))
        .toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(plan.body.data.days.every((day: { isRest: boolean }) => day.isRest)).toBe(true);
    }

    await admin.put('/api/workout-plan/7').send({}).expect(400);
  });

  it('replaces a single owned day and clears exercises when it becomes a rest day', async () => {
    const { agent: admin } = await setupAdmin();
    const updated = await admin
      .put('/api/workout-plan/0')
      .send({
        name: 'Push day',
        isRest: false,
        notes: 'Private workout note',
        exercises: [
          { name: 'Bench press', sets: 4, reps: '6-8', notes: 'Private exercise note' },
          { name: 'Cable fly', sets: 3, reps: 12, notes: null },
        ],
      })
      .expect(200);
    expect(updated.body.data.day).toMatchObject({
      dayOfWeek: 0,
      name: 'Push day',
      isRest: false,
      notes: 'Private workout note',
      exercises: [
        { name: 'Bench press', sets: 4, reps: '6-8', notes: 'Private exercise note' },
        { name: 'Cable fly', sets: 3, reps: '12', notes: null },
      ],
    });

    const rest = await admin
      .put('/api/workout-plan/0')
      .send({
        name: 'Recovery',
        isRest: true,
        notes: 'Walk and stretch',
        exercises: [{ name: 'Ignored stale exercise', sets: 1, reps: '1', notes: null }],
      })
      .expect(200);
    expect(rest.body.data.day).toMatchObject({ name: 'Recovery', isRest: true, exercises: [] });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM workout_exercises').get()).toEqual({ count: 0 });
  });
});

describe('weekly meal plan', () => {
  it('updates partial settings and returns seven days with nullable meals and totals', async () => {
    const { agent: admin } = await setupAdmin();
    const initial = await admin.get('/api/meal-plan').expect(200);
    expect(initial.body.data.settings).toEqual({
      showCalories: true,
      showMacros: true,
      calorieTarget: null,
      proteinTarget: null,
      carbsTarget: null,
      fatTarget: null,
    });
    expect(initial.body.data.days).toHaveLength(7);

    const settings = await admin
      .put('/api/meal-plan/settings')
      .send({ showMacros: false, calorieTarget: 2500, proteinTarget: 180 })
      .expect(200);
    expect(settings.body.data.settings).toMatchObject({
      showCalories: true,
      showMacros: false,
      calorieTarget: 2500,
      proteinTarget: 180,
      carbsTarget: null,
    });

    const breakfast = await admin
      .post('/api/meal-plan/meals')
      .send({
        dayOfWeek: 0,
        name: 'Breakfast',
        description: 'Oats and fruit',
        calories: 600,
        protein: 35,
        carbs: 80,
        fat: 15,
        sortOrder: 1,
      })
      .expect(201);
    const snack = await admin
      .post('/api/meal-plan/meals')
      .send({
        dayOfWeek: 0,
        name: 'Snack',
        description: null,
        calories: null,
        protein: null,
        carbs: null,
        fat: null,
        sortOrder: 0,
      })
      .expect(201);

    const plan = await admin.get('/api/meal-plan').expect(200);
    expect(plan.body.data.days[0].meals.map((meal: { name: string }) => meal.name))
      .toEqual(['Snack', 'Breakfast']);
    expect(plan.body.data.days[0].totals).toEqual({ calories: 600, protein: 35, carbs: 80, fat: 15 });

    const moved = await admin
      .patch(`/api/meal-plan/meals/${breakfast.body.data.meal.id}`)
      .send({ dayOfWeek: 1, description: 'Updated private description', calories: 650 })
      .expect(200);
    expect(moved.body.data.meal).toMatchObject({ dayOfWeek: 1, calories: 650 });
    await admin.delete(`/api/meal-plan/meals/${snack.body.data.meal.id}`).expect(200);
  });

  it('enforces meal ownership and cascades every plan table when a user is deleted', async () => {
    const { agent: admin } = await setupAdmin();
    const member = await inviteAndActivate(admin, 'Disposable');
    const meal = await member.agent
      .post('/api/meal-plan/meals')
      .send({ dayOfWeek: 2, name: 'Lunch', calories: 700, protein: 50, carbs: 70, fat: 20, sortOrder: 0 })
      .expect(201);
    await member.agent
      .put('/api/workout-plan/2')
      .send({
        name: 'Legs',
        isRest: false,
        notes: null,
        exercises: [{ name: 'Squat', sets: 5, reps: '5', notes: null }],
      })
      .expect(200);
    await member.agent
      .put('/api/meal-plan/bmr')
      .send({
        age: 34,
        sex: 'female',
        heightFeet: 5,
        heightInches: 5,
        weightSource: 'manual',
        weightValue: 65,
        weightUnit: 'kg',
      })
      .expect(200);

    await admin.patch(`/api/meal-plan/meals/${meal.body.data.meal.id}`).send({ calories: 1 }).expect(404);
    await admin.delete(`/api/meal-plan/meals/${meal.body.data.meal.id}`).expect(404);
    await admin.delete(`/api/admin/users/${member.user.id}`).expect(200);

    expect(await database.prepare('SELECT COUNT(*) AS count FROM workout_days WHERE user_id = ?').get(member.user.id))
      .toEqual({ count: 0 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM workout_exercises').get()).toEqual({ count: 0 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM meal_plan_settings WHERE user_id = ?').get(member.user.id))
      .toEqual({ count: 0 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM bmr_profiles WHERE user_id = ?').get(member.user.id))
      .toEqual({ count: 0 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM meals WHERE user_id = ?').get(member.user.id))
      .toEqual({ count: 0 });
  });
});

describe('saved BMR profile', () => {
  it('requires authentication, upserts a manual profile, and includes it in the private export', async () => {
    await request(app).get('/api/meal-plan/bmr').expect(401);
    await request(app)
      .put('/api/meal-plan/bmr')
      .send({
        age: 30,
        sex: 'male',
        heightFeet: 5,
        heightInches: 10,
        weightSource: 'manual',
        weightValue: 80,
        weightUnit: 'kg',
      })
      .expect(401);

    const { agent: admin } = await setupAdmin();
    await admin
      .get('/api/meal-plan/bmr')
      .expect(200)
      .expect(({ body }: { body: { data: unknown } }) => {
        expect(body.data).toEqual({ bmr: null });
      });

    const saved = await admin
      .put('/api/meal-plan/bmr')
      .send({
        age: 30,
        sex: 'male',
        heightFeet: 5,
        heightInches: 10,
        weightSource: 'manual',
        weightValue: 80,
        weightUnit: 'kg',
      })
      .expect(200);
    expect(saved.body.data.bmr).toEqual({
      age: 30,
      sex: 'male',
      heightFeet: 5,
      heightInches: 10,
      weightSource: 'manual',
      weightValue: 80,
      weightUnit: 'kg',
      bodyPartId: null,
      measurementId: null,
      sourceName: null,
      sourceRecordedAt: null,
      estimatedBmr: 1766,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const fetched = await admin.get('/api/meal-plan/bmr').expect(200);
    expect(fetched.body.data.bmr).toEqual(saved.body.data.bmr);

    const updated = await admin
      .put('/api/meal-plan/bmr')
      .send({
        age: 31,
        sex: 'male',
        heightFeet: 5,
        heightInches: 10,
        weightSource: 'manual',
        weightValue: 176.3698,
        weightUnit: 'lb',
      })
      .expect(200);
    expect(updated.body.data.bmr).toMatchObject({
      age: 31,
      weightValue: 176.3698,
      weightUnit: 'lb',
      estimatedBmr: 1761,
      createdAt: saved.body.data.bmr.createdAt,
    });

    const exported = await admin.get('/api/export').expect(200);
    expect(exported.body.data).toMatchObject({
      formatVersion: 3,
      bmrProfile: updated.body.data.bmr,
    });

    await admin
      .put('/api/meal-plan/bmr')
      .send({
        age: 31,
        sex: 'male',
        heightFeet: 5,
        heightInches: 10,
        weightSource: 'manual',
        weightValue: 80,
        weightUnit: 'kg',
        bodyPartId: 1,
      })
      .expect(400);
    await admin
      .put('/api/meal-plan/bmr')
      .send({
        age: 31,
        sex: 'male',
        heightFeet: 3,
        heightInches: 0,
        weightSource: 'manual',
        weightValue: 80,
        weightUnit: 'kg',
      })
      .expect(400);
  });

  it('validates measurement ownership and units while retaining a stable source snapshot', async () => {
    const { agent: admin } = await setupAdmin();
    const member = await inviteAndActivate(admin, 'Member');
    const adminParts = await admin.get('/api/body-parts').expect(200);
    const bodyWeight = adminParts.body.data.bodyParts.find(
      (part: { name: string }) => part.name === 'Body Weight',
    );
    const chest = adminParts.body.data.bodyParts.find(
      (part: { name: string }) => part.name === 'Chest',
    );
    const weightMeasurement = await admin
      .post(`/api/body-parts/${bodyWeight.id}/measurements`)
      .send({ value: 80, recordedAt: '2026-07-15' })
      .expect(201);

    const saved = await admin
      .put('/api/meal-plan/bmr')
      .send({
        age: 30,
        sex: 'female',
        heightFeet: 5,
        heightInches: 6,
        weightSource: 'measurement',
        bodyPartId: bodyWeight.id,
        measurementId: weightMeasurement.body.data.measurement.id,
      })
      .expect(200);
    expect(saved.body.data.bmr).toMatchObject({
      age: 30,
      sex: 'female',
      heightFeet: 5,
      heightInches: 6,
      weightSource: 'measurement',
      weightValue: 80,
      weightUnit: 'kg',
      bodyPartId: bodyWeight.id,
      measurementId: weightMeasurement.body.data.measurement.id,
      sourceName: 'Body Weight',
      sourceRecordedAt: weightMeasurement.body.data.measurement.recordedAt,
      estimatedBmr: 1537,
    });

    await admin
      .patch(`/api/body-parts/${bodyWeight.id}/measurements/${weightMeasurement.body.data.measurement.id}`)
      .send({ value: 100 })
      .expect(200);
    const stable = await admin.get('/api/meal-plan/bmr').expect(200);
    expect(stable.body.data.bmr).toEqual(saved.body.data.bmr);
    await admin
      .delete(`/api/body-parts/${bodyWeight.id}/measurements/${weightMeasurement.body.data.measurement.id}`)
      .expect(200);
    const stableAfterDeletion = await admin.get('/api/meal-plan/bmr').expect(200);
    expect(stableAfterDeletion.body.data.bmr).toEqual(saved.body.data.bmr);

    const unsupportedMeasurement = await admin
      .post(`/api/body-parts/${chest.id}/measurements`)
      .send({ value: 95 })
      .expect(201);
    await admin
      .put('/api/meal-plan/bmr')
      .send({
        age: 30,
        sex: 'female',
        heightFeet: 5,
        heightInches: 6,
        weightSource: 'measurement',
        bodyPartId: chest.id,
        measurementId: unsupportedMeasurement.body.data.measurement.id,
      })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ error: { code: 'BMR_WEIGHT_UNIT_UNSUPPORTED' } });
      });

    const memberParts = await member.agent.get('/api/body-parts').expect(200);
    const memberWeight = memberParts.body.data.bodyParts.find(
      (part: { name: string }) => part.name === 'Body Weight',
    );
    const memberMeasurement = await member.agent
      .post(`/api/body-parts/${memberWeight.id}/measurements`)
      .send({ value: 70 })
      .expect(201);
    await admin
      .put('/api/meal-plan/bmr')
      .send({
        age: 30,
        sex: 'female',
        heightFeet: 5,
        heightInches: 6,
        weightSource: 'measurement',
        bodyPartId: memberWeight.id,
        measurementId: memberMeasurement.body.data.measurement.id,
      })
      .expect(404)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ error: { code: 'BMR_MEASUREMENT_NOT_FOUND' } });
      });
  });

  it('keeps a saved BMR profile out of friend meal-plan sharing', async () => {
    const owner = await setupAdmin();
    const viewer = await inviteAndActivate(owner.agent, 'Viewer');
    await owner.agent
      .put('/api/meal-plan/bmr')
      .send({
        age: 42,
        sex: 'male',
        heightFeet: 6,
        heightInches: 1,
        weightSource: 'manual',
        weightValue: 90,
        weightUnit: 'kg',
      })
      .expect(200);
    await owner.agent
      .post('/api/sharing')
      .send({ viewerUserId: viewer.user.id, shareMeals: true })
      .expect(201);

    const shared = await viewer.agent.get(`/api/shared/${owner.user.id}`).expect(200);
    expect(shared.body.data).not.toHaveProperty('bmr');
    expect(shared.body.data.mealPlan).not.toHaveProperty('bmr');
    expect(JSON.stringify(shared.body)).not.toContain('estimatedBmr');
  });
});
