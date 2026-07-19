import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../server/app.js';
import { openDatabase, type Database } from '../server/db.js';
import { hashPassword } from '../server/security.js';

let database: Database;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  database = await openDatabase(':memory:');
  app = await createApp({ database, cookieSecure: false, serveStatic: false });
});

afterEach(async () => {
  await database.close();
});

async function createMember(username = 'Member', password = 'Member password!') {
  const timestamp = new Date().toISOString();
  await database.prepare(`
    INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, ?, 'user', 1, ?, ?)
  `).run(username, await hashPassword(password), timestamp, timestamp);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username, password }).expect(200);
  return agent;
}

async function createAdmin() {
  const agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ password: 'Admin setup password!' }).expect(201);
  return agent;
}

describe('authenticated resource APIs', () => {
  it('requires authentication before returning or mutating private data', async () => {
    await request(app).get('/api/body-parts').expect(401);
    await request(app).post('/api/body-parts').send({ name: 'Waist' }).expect(401);
    await request(app).get('/api/exercises').expect(401);
    await request(app).post('/api/exercises').send({ name: 'Bench Press' }).expect(401);
    await request(app).get('/api/export').expect(401);
  });

  it('validates names, dates, values, reps, and strict request shapes', async () => {
    const admin = await createAdmin();
    const parts = await admin.get('/api/body-parts').expect(200);
    const chestId = parts.body.data.bodyParts.find((part: { name: string }) => part.name === 'Chest').id;
    const exercises = await admin.get('/api/exercises').expect(200);
    const benchId = exercises.body.data.exercises.find((exercise: { name: string }) => exercise.name === 'Bench Press').id;

    await admin.post('/api/body-parts').send({ name: ' chest ' }).expect(409);
    await admin.post('/api/body-parts').send({ name: 'Forearm', unexpected: true }).expect(400);
    await admin.patch(`/api/body-parts/${chestId}`).send({}).expect(400);
    await admin.post(`/api/body-parts/${chestId}/measurements`).send({ value: 0 }).expect(400);
    await admin.post(`/api/body-parts/${chestId}/measurements`)
      .send({ value: 100, recordedAt: 'not-a-date' })
      .expect(400);

    await admin.post('/api/exercises').send({ name: ' bench press ' }).expect(409);
    await admin.patch(`/api/exercises/${benchId}`).send({}).expect(400);
    await admin.post(`/api/exercises/${benchId}/lifts`).send({ weight: -1, reps: 1 }).expect(400);
    await admin.post(`/api/exercises/${benchId}/lifts`).send({ weight: 100, reps: 1.5 }).expect(400);
    await admin.get('/api/exercises/not-an-id/lifts').expect(400);

    expect(await database.prepare('SELECT COUNT(*) AS count FROM measurements').get()).toEqual({ count: 0 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM lift_records').get()).toEqual({ count: 0 });
  });

  it('locks units while historical records exist and unlocks them after record deletion', async () => {
    const admin = await createAdmin();
    const parts = await admin.get('/api/body-parts').expect(200);
    const chest = parts.body.data.bodyParts.find((part: { name: string }) => part.name === 'Chest');
    const measurement = await admin
      .post(`/api/body-parts/${chest.id}/measurements`)
      .send({ value: 100 })
      .expect(201);

    const lockedPart = await admin
      .patch(`/api/body-parts/${chest.id}`)
      .send({ unit: 'in' })
      .expect(409);
    expect(lockedPart.body).toMatchObject({ error: { code: 'BODY_PART_UNIT_LOCKED' } });
    await admin.patch(`/api/body-parts/${chest.id}`).send({ name: 'Chest circumference' }).expect(200);
    await admin
      .delete(`/api/body-parts/${chest.id}/measurements/${measurement.body.data.measurement.id}`)
      .expect(200);
    const changedPart = await admin.patch(`/api/body-parts/${chest.id}`).send({ unit: 'in' }).expect(200);
    expect(changedPart.body.data.bodyPart.unit).toBe('in');

    const exercises = await admin.get('/api/exercises').expect(200);
    const bench = exercises.body.data.exercises.find((exercise: { name: string }) => exercise.name === 'Bench Press');
    const lift = await admin
      .post(`/api/exercises/${bench.id}/lifts`)
      .send({ weight: 100, reps: 1 })
      .expect(201);

    const lockedExercise = await admin
      .patch(`/api/exercises/${bench.id}`)
      .send({ unit: 'lb' })
      .expect(409);
    expect(lockedExercise.body).toMatchObject({ error: { code: 'EXERCISE_UNIT_LOCKED' } });
    await admin.patch(`/api/exercises/${bench.id}`).send({ category: 'Push' }).expect(200);
    await admin.delete(`/api/exercises/${bench.id}/lifts/${lift.body.data.lift.id}`).expect(200);
    const changedExercise = await admin.patch(`/api/exercises/${bench.id}`).send({ unit: 'lb' }).expect(200);
    expect(changedExercise.body.data.exercise.unit).toBe('lb');
  });
});

describe('per-user ownership', () => {
  it('isolates body-part lists and denies cross-user measurement reads and mutations', async () => {
    const admin = await createAdmin();
    const member = await createMember();

    const createdPart = await member
      .post('/api/body-parts')
      .send({ name: 'Member-only forearm', unit: 'cm', color: '#123abc' })
      .expect(201);
    const memberPartId = createdPart.body.data.bodyPart.id as number;
    const createdMeasurement = await member
      .post(`/api/body-parts/${memberPartId}/measurements`)
      .send({ value: 31.5, recordedAt: '2026-07-14', note: 'private' })
      .expect(201);
    const memberMeasurementId = createdMeasurement.body.data.measurement.id as number;

    const adminParts = await admin.get('/api/body-parts').expect(200);
    expect(adminParts.body.data.bodyParts).not.toContainEqual(
      expect.objectContaining({ id: memberPartId }),
    );
    const adminPartId = adminParts.body.data.bodyParts[0].id as number;

    await admin.get(`/api/body-parts/${memberPartId}/measurements`).expect(404);
    await admin.patch(`/api/body-parts/${memberPartId}`).send({ name: 'Stolen' }).expect(404);
    await admin.delete(`/api/body-parts/${memberPartId}`).expect(404);
    await admin
      .patch(`/api/body-parts/${adminPartId}/measurements/${memberMeasurementId}`)
      .send({ value: 999 })
      .expect(404);
    await admin
      .delete(`/api/body-parts/${adminPartId}/measurements/${memberMeasurementId}`)
      .expect(404);

    const stillOwned = await member.get(`/api/body-parts/${memberPartId}/measurements`).expect(200);
    expect(stillOwned.body.data.measurements).toEqual([
      expect.objectContaining({ id: memberMeasurementId, value: 31.5, note: 'private' }),
    ]);
  });

  it('isolates exercise lists and denies cross-user lift reads and mutations', async () => {
    const admin = await createAdmin();
    const member = await createMember();

    const createdExercise = await member
      .post('/api/exercises')
      .send({ name: 'Member-only curl', category: 'Arms', unit: 'kg', color: '#abcdef' })
      .expect(201);
    const memberExerciseId = createdExercise.body.data.exercise.id as number;
    const createdLift = await member
      .post(`/api/exercises/${memberExerciseId}/lifts`)
      .send({ weight: 24, reps: 8, recordedAt: '2026-07-14', note: 'private' })
      .expect(201);
    const memberLiftId = createdLift.body.data.lift.id as number;

    const adminExercises = await admin.get('/api/exercises').expect(200);
    expect(adminExercises.body.data.exercises).not.toContainEqual(
      expect.objectContaining({ id: memberExerciseId }),
    );
    const adminExerciseId = adminExercises.body.data.exercises[0].id as number;

    await admin.get(`/api/exercises/${memberExerciseId}/lifts`).expect(404);
    await admin.patch(`/api/exercises/${memberExerciseId}`).send({ name: 'Stolen' }).expect(404);
    await admin.delete(`/api/exercises/${memberExerciseId}`).expect(404);
    await admin
      .patch(`/api/exercises/${adminExerciseId}/lifts/${memberLiftId}`)
      .send({ weight: 999 })
      .expect(404);
    await admin
      .delete(`/api/exercises/${adminExerciseId}/lifts/${memberLiftId}`)
      .expect(404);

    const stillOwned = await member.get(`/api/exercises/${memberExerciseId}/lifts`).expect(200);
    expect(stillOwned.body.data.lifts).toEqual([
      expect.objectContaining({ id: memberLiftId, weight: 24, reps: 8, note: 'private' }),
    ]);
  });
});

describe('private data export', () => {
  it('exports only the authenticated user and their nested records', async () => {
    const admin = await createAdmin();
    const member = await createMember();

    const part = await member
      .post('/api/body-parts')
      .send({ name: 'Exported waist', unit: 'cm', color: '#334455' })
      .expect(201);
    await member
      .post(`/api/body-parts/${part.body.data.bodyPart.id}/measurements`)
      .send({ value: 82.4, recordedAt: '2026-07-01', note: 'member measurement' })
      .expect(201);
    const exercise = await member
      .post('/api/exercises')
      .send({ name: 'Exported press', category: 'Push', unit: 'kg', color: '#556677' })
      .expect(201);
    await member
      .post(`/api/exercises/${exercise.body.data.exercise.id}/lifts`)
      .send({ weight: 70, reps: 3, recordedAt: '2026-07-02', note: 'member lift' })
      .expect(201);

    const memberExport = await member.get('/api/export').expect(200);
    expect(memberExport.headers['content-disposition']).toMatch(/^attachment; filename="forge-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(memberExport.body.data).toMatchObject({
      formatVersion: 4,
      user: { username: 'Member', role: 'user' },
      bodyParts: [{
        name: 'Exported waist',
        measurements: [{ value: 82.4, note: 'member measurement' }],
      }],
      exercises: [{
        name: 'Exported press',
        lifts: [{ weight: 70, reps: 3, note: 'member lift' }],
      }],
      sharing: { outgoingShares: [], incomingShares: [] },
      mobileNavigation: {
        items: ['dashboard', 'measurements', 'lifts', 'workout'],
      },
    });
    expect(memberExport.body.data.workoutPlan.days).toHaveLength(7);
    expect(memberExport.body.data.mealPlan.days).toHaveLength(7);
    expect(memberExport.body.data.mealPlan.settings).toEqual({
      showCalories: true,
      showMacros: true,
      calorieTarget: null,
      proteinTarget: null,
      carbsTarget: null,
      fatTarget: null,
    });
    expect(JSON.stringify(memberExport.body)).not.toContain('Bench Press');
    expect(JSON.stringify(memberExport.body)).not.toContain('Admin');

    const adminExport = await admin.get('/api/export').expect(200);
    expect(JSON.stringify(adminExport.body)).not.toContain('Exported waist');
    expect(JSON.stringify(adminExport.body)).not.toContain('Exported press');
  });
});
