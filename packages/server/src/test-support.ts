/**
 * Shared helpers for this package's tests. Excluded from the build: this file
 * ships nowhere.
 */

import { SECTION_KEYS } from "@nativesoil/handover-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { startServer } from "./http.js";
import { SILENT_LOGGER, type LogEvent, type Logger } from "./log.js";
import { Registry } from "./registry.js";

/** A throwaway server home. */
export function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "soil-server-test-"));
}

/** Tokens per seeded user. */
export interface SeededTokens {
  readonly alice: string;
  readonly bob: string;
  readonly mallory: string;
}

/**
 * Seed a home with three users and one project: `team-x`, whose members are
 * alice and bob. mallory is a valid user with no membership, which is what
 * the isolation tests are about.
 */
export function seedHome(home: string): SeededTokens {
  const registry = new Registry(home);
  registry.init();
  const alice = registry.addUser("alice");
  const bob = registry.addUser("bob");
  const mallory = registry.addUser("mallory");
  registry.addProject("team-x", ["alice", "bob"], "Team X");
  return { alice, bob, mallory };
}

/** A logger that keeps every line, so a test can read the audit trail. */
export function recordingLogger(): Logger & { readonly lines: LogEvent[] } {
  const lines: LogEvent[] = [];
  return {
    lines,
    log(event: LogEvent): void {
      lines.push(event);
    },
  };
}

/** A running test server on an ephemeral localhost port. */
export interface TestServer {
  readonly base: string;
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Start a server for one test home. Request logging is off unless the test
 * hands in a logger, so the suite's output stays readable.
 */
export async function startTestServer(
  home: string,
  logger: Logger = SILENT_LOGGER,
): Promise<TestServer> {
  const started = await startServer({ home, port: 0, logger });
  return {
    base: `http://127.0.0.1:${started.port}`,
    server: started.server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        started.server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** The user id behind a seeded username, for tests that need a store path. */
export function userIdOf(home: string, username: string): string {
  const user = new Registry(home).findUser(username);
  if (user === undefined) throw new Error(`no such user: ${username}`);
  return user.userId;
}

/** Where a user's personal handovers live on disk. */
export function personalHandoversDir(home: string, username: string): string {
  return join(home, "users", userIdOf(home, username), "handovers");
}

/** Remove a test home. */
export function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** A structurally valid handover document with a few sections filled. */
export function validHandover(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const sections: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) {
    sections[key] = { status: "missing", summary: null };
  }
  sections["projectIdentity"] = {
    status: "available",
    summary: "Ship the billing rework without breaking invoicing.",
  };
  sections["decisions"] = {
    status: "available",
    summary: "Postgres stays; the queue moves to the outbox pattern.",
  };
  return {
    soilHandover: "1.0",
    projectId: "billing-rework",
    title: "Billing rework, midpoint",
    createdAt: "2026-07-24T10:00:00.000Z",
    sections,
    ...overrides,
  };
}

/**
 * One JSON round trip against a test server. `text` is the response body
 * exactly as it arrived, for the tests that compare answers byte for byte
 * rather than field by field.
 */
export async function requestJson(
  base: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
}> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    json: raw.length > 0 ? JSON.parse(raw) : undefined,
    text: raw,
    headers: response.headers,
  };
}
