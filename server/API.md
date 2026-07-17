# Forge Gym Tracker API

All request and response bodies are JSON. Successful responses use `{ "data": ... }`.
Errors use `{ "error": { "code": string, "message": string, "details"?: unknown } }`.
Private routes authenticate with the HTTP-only `forge_session` cookie. Request bodies are
strict: unknown fields are rejected.

## Authentication and invitations

| Method | Route | Body | `data` |
| --- | --- | --- | --- |
| GET | `/api/auth/status` | - | `{ setupRequired, authenticated, user }` |
| POST | `/api/auth/setup` | `{ username?, password }` | `{ user }` (201); creates and signs in the first `admin` |
| POST | `/api/auth/activate` | `{ username, inviteCode, newPassword }` | `{ user }`; consumes the invite and signs in |
| POST | `/api/auth/login` | `{ username, password }` | `{ user }` |
| POST | `/api/auth/logout` | - | `{ success: true }` |
| GET | `/api/auth/me` | - | `{ user }` |
| PATCH | `/api/auth/profile` | `{ username }` | `{ user }`; renames the current account without ending its session |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` | `{ success: true }` and a rotated session |

`user` is `{ id, username, role, isActive, requiresPasswordSetup, createdAt, updatedAt,
lastLoginAt }`. Passwords are 8-128 characters. Usernames are 2-32 characters and may contain
letters, numbers, dots, underscores, and hyphens. They are unique without regard to case.
Initial setup is available only while the user table is empty, defaults its editable username
to `Admin`, and does not use the invitation flow.

Profile renaming requires an authenticated session, preserves the account role and all current
sessions, and records an audit event. A conflicting username returns `409 USERNAME_EXISTS`.

An admin-created account starts with `requiresPasswordSetup: true`. Normal login for that
account returns `409 PASSWORD_SETUP_REQUIRED`; the user must activate it with the one-time
invite code. Invite codes are high-entropy, returned only by the create/reset response, and
stored only as hashes. Activation consumes the code. Invalid or already-consumed codes return
`400 INVALID_INVITE_CODE` without disclosing which credential was wrong.

Only failed login attempts consume the login rate limit. Activation attempts have a separate
rate limit. Calls to the closed setup endpoint cannot exhaust the login quota.

## Body measurements

| Method | Route | Body | `data` |
| --- | --- | --- | --- |
| GET | `/api/body-parts` | - | `{ bodyParts }` |
| PUT | `/api/body-parts/order` | `{ ids: number[] }` | `{ bodyParts }` in the saved order |
| POST | `/api/body-parts` | `{ name, unit?: "cm", color?: "#f97316" }` | `{ bodyPart }` (201) |
| PATCH | `/api/body-parts/:bodyPartId` | any of `{ name, unit, color }` | `{ bodyPart }` |
| DELETE | `/api/body-parts/:bodyPartId` | - | `{ success: true }` |
| GET | `/api/body-parts/:bodyPartId/measurements` | - | `{ measurements }` in chart order |
| POST | `/api/body-parts/:bodyPartId/measurements` | `{ value, recordedAt?, note? }` | `{ measurement }` (201) |
| PATCH | `/api/body-parts/:bodyPartId/measurements/:measurementId` | any of `{ value, recordedAt, note }` | `{ measurement }` |
| DELETE | `/api/body-parts/:bodyPartId/measurements/:measurementId` | - | `{ success: true }` |

`bodyPart` is `{ id, name, unit, color, sortOrder, createdAt, updatedAt, recordCount, latestValue,
latestRecordedAt }`. `measurement` is `{ id, bodyPartId, value, recordedAt, note, createdAt,
updatedAt }`.

The reorder body must contain every body-part ID owned by the signed-in user exactly once.
Duplicates, missing IDs, extra IDs, and IDs owned by another user return
`400 ORDER_IDS_MISMATCH`; no positions are changed. A newly created body part is appended.

Once a body part has records, changing its unit returns `409 BODY_PART_UNIT_LOCKED`; delete
its records first to change the unit.

## Max lifts

| Method | Route | Body | `data` |
| --- | --- | --- | --- |
| GET | `/api/exercises` | - | `{ exercises }` |
| PUT | `/api/exercises/order` | `{ ids: number[] }` | `{ exercises }` in the saved order |
| POST | `/api/exercises` | `{ name, category?: "Strength", unit?: "kg", color?: "#f97316" }` | `{ exercise }` (201) |
| PATCH | `/api/exercises/:exerciseId` | any of `{ name, category, unit, color }` | `{ exercise }` |
| DELETE | `/api/exercises/:exerciseId` | - | `{ success: true }` |
| GET | `/api/exercises/:exerciseId/lifts` | - | `{ lifts }` in chart order |
| POST | `/api/exercises/:exerciseId/lifts` | `{ weight, reps?: 1, recordedAt?, note? }` | `{ lift }` (201) |
| PATCH | `/api/exercises/:exerciseId/lifts/:liftId` | any of `{ weight, reps, recordedAt, note }` | `{ lift }` |
| DELETE | `/api/exercises/:exerciseId/lifts/:liftId` | - | `{ success: true }` |

`exercise` is `{ id, name, category, unit, color, sortOrder, createdAt, updatedAt, recordCount,
personalBest, latestWeight, latestReps, latestRecordedAt }`. `lift` is `{ id, exerciseId,
weight, reps, recordedAt, note, createdAt, updatedAt }`.

The reorder body must contain every exercise ID owned by the signed-in user exactly once.
Duplicates, missing IDs, extra IDs, and IDs owned by another user return
`400 ORDER_IDS_MISMATCH`; no positions are changed. A newly created exercise is appended.

Once an exercise has records, changing its unit returns `409 EXERCISE_UNIT_LOCKED`; delete
its records first to change the unit.

## Weekly workout plan

Day numbers use `0 = Monday` through `6 = Sunday`.

| Method | Route | Body | `data` |
| --- | --- | --- | --- |
| GET | `/api/workout-plan` | - | `{ days }` |
| PUT | `/api/workout-plan/:dayOfWeek` | `{ name, isRest, notes?, exercises }` | `{ day }` |

A workout day is `{ dayOfWeek, name, isRest, notes, exercises }`. An exercise is
`{ id, name, sets, reps, notes }`; `reps` is returned as a string and can be sent as a
non-empty string or positive number. PUT replaces the day's exercise list. If `isRest` is
true, the stored exercise list is cleared regardless of the submitted list.

Every account has exactly seven seeded workout days, initially named `Rest day`.

## Meal plan

| Method | Route | Body | `data` |
| --- | --- | --- | --- |
| GET | `/api/meal-plan` | - | `{ settings, days }` |
| PUT | `/api/meal-plan/settings` | any of the settings fields | `{ settings }` |
| GET | `/api/meal-plan/bmr` | - | `{ bmr }`; `bmr` is the saved profile or `null` |
| PUT | `/api/meal-plan/bmr` | BMR profile input | `{ bmr }` |
| POST | `/api/meal-plan/meals` | meal fields | `{ meal }` (201) |
| PATCH | `/api/meal-plan/meals/:mealId` | any meal fields | `{ meal }` |
| DELETE | `/api/meal-plan/meals/:mealId` | - | `{ success: true }` |

Settings are `{ showCalories, showMacros, calorieTarget, proteinTarget, carbsTarget,
fatTarget }`. Targets are non-negative numbers or `null`.

Meal fields are `{ dayOfWeek, name, description?, calories?, protein?, carbs?, fat?,
sortOrder? }`. Nutrition fields and `description` can be `null`. A returned meal is
`{ id, dayOfWeek, name, description, calories, protein, carbs, fat, sortOrder, createdAt,
updatedAt }`.

`days` always contains all seven days in order. Each item is `{ dayOfWeek, meals, totals }`,
where `totals` is `{ calories, protein, carbs, fat }`; missing nutrition values contribute
zero. Meals are ordered by `sortOrder`, then ID. New accounts start with calories and macros
visible, null targets, and no meals.

A BMR profile input contains `{ age, sex, heightFeet, heightInches, weightSource }`. `age`
is an integer from 18 through 120, `sex` is `female` or `male`, feet are an integer from 3
through 9, inches are at least 0 and less than 12, and the combined height must be 100-275 cm.
For `weightSource: "manual"`, also send `{ weightValue, weightUnit }`, where the unit is
`kg`, `lb`, or decimal `st`. For `weightSource: "measurement"`, send `{ bodyPartId,
measurementId }`; the server verifies that the record belongs to the signed-in user and uses
a supported weight unit. Converted weight must be 20-500 kg.

The server calculates the Mifflin-St Jeor result and stores a snapshot of the chosen weight.
The returned BMR includes the submitted profile fields plus `{ weightValue, weightUnit,
bodyPartId, measurementId, sourceName, sourceRecordedAt, estimatedBmr, createdAt, updatedAt }`.
Editing or deleting the original measurement does not silently change a saved result. BMR
profiles are owner-only and are never included in shared meal-plan projections.

## Sharing progress

Sharing is explicit and directional: the owner grants one viewer access to selected sections.

| Method | Route | Body | `data` |
| --- | --- | --- | --- |
| GET | `/api/sharing` | - | `{ availableUsers, outgoingShares, incomingShares }` |
| POST | `/api/sharing` | `{ viewerUserId, shareMeasurements?, shareLifts?, shareWorkout?, shareMeals? }` | `{ share }` (201) |
| PATCH | `/api/sharing/:shareId` | any permission fields | `{ share }` |
| DELETE | `/api/sharing/:shareId` | - | `{ success: true }` |
| GET | `/api/shared/:ownerUserId` | - | shared progress projection |

A share is `{ id, owner: { id, username }, viewer: { id, username }, shareMeasurements,
shareLifts, shareWorkout, shareMeals, createdAt, updatedAt }`. `availableUsers` contains active,
fully activated users not already receiving an outgoing share from the current owner. Owners cannot share
with themselves or create duplicate grants. At least one permission must remain enabled;
revoke an unwanted share with DELETE instead.

`GET /api/shared/:ownerUserId` is available only to the named viewer and returns
`{ owner, permissions, measurements?, lifts?, workoutPlan?, mealPlan? }`. Ungranted sections
are omitted rather than returned empty. Shared measurement and lift collections retain the
owner's saved resource order. It is a read-only projection:

- Measurement and lift record notes are always `null`.
- Workout day and exercise notes are always `null`.
- Meal descriptions are always `null`.
- When the owner has `showCalories: false`, shared calorie targets/values are `null` and
  shared calorie totals are zero.
- When the owner has `showMacros: false`, shared macro targets/values are `null` and shared
  macro totals are zero.

All normal mutation routes remain ownership-scoped, so a viewer cannot edit the owner's data.

## Administration

These routes require the current database role to be `admin`.

| Method | Route | Body/query | `data` |
| --- | --- | --- | --- |
| GET | `/api/admin/overview` | - | user/record/session counts and `recentAudit` |
| GET | `/api/admin/users` | - | `{ users }` with per-user record counts |
| POST | `/api/admin/users` | `{ username, role?: "user" }` | `{ user, inviteCode }` (201) |
| PATCH | `/api/admin/users/:userId/status` | `{ isActive }` | `{ user }` |
| POST | `/api/admin/users/:userId/reset-invite` | - | `{ user, inviteCode }` |
| DELETE | `/api/admin/users/:userId` | - | `{ success: true }` |
| GET | `/api/admin/audit` | `?limit=50&offset=0` | `{ auditEntries, pagination }` |

The first-run account is the sole administrator; invited accounts are always members. Resetting an invitation
invalidates the target's password and all sessions, re-enables the account, marks it as requiring
activation, rotates the one-time code, and returns that new code once. An administrator
cannot reset, disable, or delete their own account; password changes use the normal account route.

Audit entries retain an immutable actor-username snapshot when an account is deleted.
Training-event metadata is not persisted and is redacted from admin responses, so measurements,
weights, repetitions, dates, notes, body-part names, exercise names, workout-plan content, and
meal-plan content remain private.

## Export, deletion, and health

- `GET /api/export` downloads format version 3 for the signed-in user as
  `{ formatVersion, exportedAt, user, bodyParts, exercises, workoutPlan, mealPlan, bmrProfile, sharing }`.
  Body parts and exercises retain the user's saved resource order and include `sortOrder`.
  `sharing` contains only the user's outgoing/incoming permission metadata, never another
  user's progress records.
- `GET /api/health` returns `{ status: "ok" }`.

The initial administrator and every invited account receive independent default body
parts, exercises, seven workout days, and meal settings. Deleting an account cascades through
its sessions, body data, lift data, workout plan, meal plan, BMR profile, and any incoming or
outgoing sharing grants.

Every resource query includes the signed-in user's ID. Nested-record routes also verify
ownership of their parent. In production the API serves `dist/` and falls back to
`dist/index.html` for client-side routes.

## Reverse proxies

`TRUST_PROXY` is optional and is applied before authentication rate limiting. Leave it unset
or set it to `0` for direct connections. For one known reverse-proxy hop use `TRUST_PROXY=1`;
Express also accepts a trusted address/subnet or comma-separated address list. Do not use a
permissive setting unless every direct connection is blocked by the trusted proxy.
