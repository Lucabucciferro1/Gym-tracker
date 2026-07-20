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
  return { agent, user: response.body.data.user as { id: number; username: string } };
}

async function inviteAndActivate(admin: ReturnType<typeof request.agent>, username: string) {
  const invited = await admin
    .post('/api/admin/users')
    .send({ username, role: 'user' })
    .expect(201);
  const agent = request.agent(app);
  const activated = await agent
    .post('/api/auth/activate')
    .send({
      username,
      inviteCode: invited.body.data.inviteCode,
      newPassword: `${username} secure password!`,
    })
    .expect(200);
  return { agent, user: activated.body.data.user as { id: number; username: string } };
}

describe('sharing grants', () => {
  it('lists available users and enforces owner-only CRUD with a non-empty permission invariant', async () => {
    const owner = await setupAdmin();
    const viewer = await inviteAndActivate(owner.agent, 'Viewer');
    const outsider = await inviteAndActivate(owner.agent, 'Outsider');
    const pending = await owner.agent
      .post('/api/admin/users')
      .send({ username: 'Pending', role: 'user' })
      .expect(201);

    const initial = await owner.agent.get('/api/sharing').expect(200);
    expect(initial.body.data.availableUsers).toEqual(expect.arrayContaining([
      { id: viewer.user.id, username: 'Viewer' },
      { id: outsider.user.id, username: 'Outsider' },
    ]));
    expect(initial.body.data.availableUsers).not.toContainEqual(
      expect.objectContaining({ id: pending.body.data.user.id }),
    );
    await owner.agent
      .post('/api/sharing')
      .send({ viewerUserId: pending.body.data.user.id, shareMeasurements: true })
      .expect(404);
    await owner.agent
      .post('/api/sharing')
      .send({ viewerUserId: viewer.user.id })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ error: { code: 'SHARE_REQUIRES_PERMISSION' } });
      });
    await owner.agent
      .post('/api/sharing')
      .send({ viewerUserId: owner.user.id, shareMeasurements: true })
      .expect(400);

    const created = await owner.agent
      .post('/api/sharing')
      .send({
        viewerUserId: viewer.user.id,
        shareMeasurements: true,
        shareLifts: true,
      })
      .expect(201);
    const share = created.body.data.share;
    expect(share).toMatchObject({
      owner: { id: owner.user.id, username: 'Admin' },
      viewer: { id: viewer.user.id, username: 'Viewer' },
      shareMeasurements: true,
      shareLifts: true,
      shareWorkout: false,
      shareMeals: false,
    });
    await owner.agent
      .post('/api/sharing')
      .send({ viewerUserId: viewer.user.id, shareWorkout: true })
      .expect(409);

    const ownerOverview = await owner.agent.get('/api/sharing').expect(200);
    expect(ownerOverview.body.data.availableUsers).not.toContainEqual(
      expect.objectContaining({ id: viewer.user.id }),
    );
    expect(ownerOverview.body.data.outgoingShares).toEqual([expect.objectContaining({ id: share.id })]);
    const viewerOverview = await viewer.agent.get('/api/sharing').expect(200);
    expect(viewerOverview.body.data.incomingShares).toEqual([expect.objectContaining({ id: share.id })]);

    await viewer.agent.patch(`/api/sharing/${share.id}`).send({ shareMeals: true }).expect(404);
    await viewer.agent.delete(`/api/sharing/${share.id}`).expect(404);
    await owner.agent
      .patch(`/api/sharing/${share.id}`)
      .send({ shareMeasurements: false, shareLifts: false })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ error: { code: 'SHARE_REQUIRES_PERMISSION' } });
      });

    const updated = await owner.agent
      .patch(`/api/sharing/${share.id}`)
      .send({ shareMeasurements: false, shareWorkout: true })
      .expect(200);
    expect(updated.body.data.share).toMatchObject({
      shareMeasurements: false,
      shareLifts: true,
      shareWorkout: true,
    });
    await owner.agent.delete(`/api/sharing/${share.id}`).expect(200);
    await viewer.agent.get(`/api/shared/${owner.user.id}`).expect(404);
  });

  it('returns only permitted read-only projections and redacts notes and hidden nutrition', async () => {
    const owner = await setupAdmin();
    const viewer = await inviteAndActivate(owner.agent, 'Viewer');
    const outsider = await inviteAndActivate(owner.agent, 'Outsider');
    const parts = await owner.agent.get('/api/body-parts').expect(200);
    const partId = parts.body.data.bodyParts[0].id as number;
    const measurement = await owner.agent
      .post(`/api/body-parts/${partId}/measurements`)
      .send({ value: 81.2, note: 'private measurement note' })
      .expect(201);
    const exercises = await owner.agent.get('/api/exercises').expect(200);
    const exerciseId = exercises.body.data.exercises[0].id as number;
    await owner.agent
      .post(`/api/exercises/${exerciseId}/lifts`)
      .send({ weight: 120, reps: 3, note: 'private lift note' })
      .expect(201);
    await owner.agent
      .put('/api/workout-plan/0')
      .send({
        name: 'Push',
        isRest: false,
        notes: 'private workout note',
        exercises: [{ exerciseId, sets: 4, reps: '6', notes: 'private exercise note' }],
      })
      .expect(200);
    await owner.agent.patch(`/api/exercises/${exerciseId}`).send({ name: 'Shared Bench' }).expect(200);
    await owner.agent
      .put('/api/meal-plan/settings')
      .send({
        showCalories: false,
        showMacros: false,
        calorieTarget: 2500,
        proteinTarget: 180,
        carbsTarget: 300,
        fatTarget: 70,
      })
      .expect(200);
    await owner.agent
      .post('/api/meal-plan/meals')
      .send({
        dayOfWeek: 0,
        name: 'Breakfast',
        description: 'private meal description',
        calories: 600,
        protein: 35,
        carbs: 80,
        fat: 15,
        sortOrder: 0,
      })
      .expect(201);

    const created = await owner.agent
      .post('/api/sharing')
      .send({
        viewerUserId: viewer.user.id,
        shareMeasurements: true,
        shareWorkout: true,
        shareMeals: true,
      })
      .expect(201);
    await outsider.agent.get(`/api/shared/${owner.user.id}`).expect(404);

    const shared = await viewer.agent.get(`/api/shared/${owner.user.id}`).expect(200);
    expect(shared.body.data.owner).toEqual({ id: owner.user.id, username: 'Admin' });
    expect(shared.body.data.permissions).toEqual({
      shareMeasurements: true,
      shareLifts: false,
      shareWorkout: true,
      shareMeals: true,
    });
    expect(shared.body.data).not.toHaveProperty('lifts');
    expect(shared.body.data.measurements[0].records[0]).toMatchObject({ value: 81.2, note: null });
    expect(shared.body.data.workoutPlan.days[0]).toMatchObject({
      notes: null,
      exercises: [expect.objectContaining({
        exerciseId,
        name: 'Shared Bench',
        notes: null,
      })],
    });
    expect(shared.body.data.mealPlan.settings).toMatchObject({
      showCalories: false,
      showMacros: false,
      calorieTarget: null,
      proteinTarget: null,
      carbsTarget: null,
      fatTarget: null,
    });
    expect(shared.body.data.mealPlan.days[0].meals[0]).toMatchObject({
      description: null,
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
    });
    expect(shared.body.data.mealPlan.days[0].totals).toEqual({
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
    });
    const ownerMealPlan = await owner.agent.get('/api/meal-plan').expect(200);
    expect(ownerMealPlan.body.data.mealPlan).toBeUndefined();
    expect(ownerMealPlan.body.data.days[0].meals[0]).toMatchObject({ calories: 600, protein: 35 });

    await viewer.agent
      .patch(`/api/body-parts/${partId}/measurements/${measurement.body.data.measurement.id}`)
      .send({ value: 1 })
      .expect(404);
    await owner.agent
      .patch(`/api/sharing/${created.body.data.share.id}`)
      .send({ shareLifts: true })
      .expect(200);
    const withLifts = await viewer.agent.get(`/api/shared/${owner.user.id}`).expect(200);
    expect(withLifts.body.data.lifts[0].records[0]).toMatchObject({ weight: 120, note: null });
  });

  it('cascades grants when either participating user is deleted', async () => {
    const owner = await setupAdmin();
    const viewer = await inviteAndActivate(owner.agent, 'DisposableViewer');
    await owner.agent
      .post('/api/sharing')
      .send({ viewerUserId: viewer.user.id, shareMeasurements: true })
      .expect(201);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM sharing_permissions').get()).toEqual({ count: 1 });
    await owner.agent.delete(`/api/admin/users/${viewer.user.id}`).expect(200);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM sharing_permissions').get()).toEqual({ count: 0 });
  });
});
