import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../server/app.js';
import { openDatabase, type Database } from '../server/db.js';

let database: Database;
let temporaryDirectory: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'forge-plans-test-'));
  database = openDatabase(join(temporaryDirectory, 'forge.db'));
  app = createApp({ database, cookieSecure: false, serveStatic: false });
});

afterEach(() => {
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
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
    expect(database.prepare('SELECT COUNT(*) AS count FROM workout_exercises').get()).toEqual({ count: 0 });
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

    await admin.patch(`/api/meal-plan/meals/${meal.body.data.meal.id}`).send({ calories: 1 }).expect(404);
    await admin.delete(`/api/meal-plan/meals/${meal.body.data.meal.id}`).expect(404);
    await admin.delete(`/api/admin/users/${member.user.id}`).expect(200);

    expect(database.prepare('SELECT COUNT(*) AS count FROM workout_days WHERE user_id = ?').get(member.user.id))
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM workout_exercises').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM meal_plan_settings WHERE user_id = ?').get(member.user.id))
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM meals WHERE user_id = ?').get(member.user.id))
      .toEqual({ count: 0 });
  });
});
