import 'dotenv/config';
import { createApp } from './app.js';

const rawPort = Number(process.env.PORT ?? 3001);
const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65_535 ? rawPort : 3001;
const host = '0.0.0.0';
const app = await createApp({ serveStatic: true });

const server = app.listen(port, host, () => {
  console.log(`Forge Gym Tracker API listening on http://${host}:${port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received; shutting down`);
  server.close(() => {
    const closeDatabase = app.locals.closeDatabase as (() => void) | undefined;
    closeDatabase?.();
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
