/**
 * The admin CLI: `soil-server`.
 *
 * Administration is filesystem access, not an HTTP surface: whoever can run
 * this binary on the machine that holds the data directory is the operator.
 * There are no admin endpoints, no roles, and no way to mint a token over the
 * network.
 *
 * Everything an operator has to do to a running team now has a command. Before
 * these existed, offboarding a person meant editing `users.json` by hand on a
 * server that was reading and writing that same file without a lock, and adding
 * somebody to an existing project was not possible at all. Every command here
 * goes through the same registry lock the server does, so running one against a
 * live server is safe.
 *
 * Tokens are printed exactly once, at creation, and only their hashes are
 * stored. A lost token is replaced with `user remove` followed by `user add`,
 * which is deliberately a new account: the replacement gets a new user id, and
 * inherits nothing.
 */

import { LockBusyError } from "@nativesoil/handover-sdk";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { resolveServerHome } from "./home.js";
import { startServer } from "./http.js";
import { createLogger } from "./log.js";
import { Registry, RegistryError } from "./registry.js";

const USAGE = `soil-server: the self-hostable Soil Handover server

Usage:
  soil-server init [--admin <name>]          create the data directory and the first user
  soil-server serve --port <p> [--host <h>] [--allow-origin <a,b>]
                                             start the server (binds 127.0.0.1 by default;
                                             --allow-origin names browser origins to answer
                                             besides the loopback ones)
  soil-server migrate                        bring an older data directory up to date

  soil-server user add <name>                add a user and print their token, once
  soil-server user list                      list users, with their stable ids
  soil-server user rename <old> <new>        change a username; the id and the data stay
  soil-server user remove <name> [--purge]   revoke the token and drop every membership
                                             (--purge also deletes their personal store)

  soil-server project add <id> --members <a,b> [--name <display>]
                                             create a shared project
  soil-server project list                   list projects
  soil-server project member add <id> <name>       add someone to an existing project
  soil-server project member remove <id> <name>    remove someone; the handovers stay
  soil-server project remove <id> [--purge]        remove the project
                                             (--purge also deletes its shared store)

Data lives under SOIL_SERVER_HOME (default ~/.soil-server).
Request logging goes to stdout as JSON; SOIL_SERVER_LOG=none turns it off.`;

interface CliIo {
  readonly env: NodeJS.ProcessEnv;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  return argv[at + 1];
}

function tokenBanner(username: string, token: string): string {
  return [
    `Created user ${username}.`,
    ``,
    `  Token: ${token}`,
    ``,
    `This token is shown once and is not stored on the server; only its hash is.`,
    `Give it to ${username} to use as: Authorization: Bearer <token>`,
  ].join("\n");
}

/** Run the CLI. Returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  io?: Partial<CliIo>,
): Promise<number> {
  const env = io?.env ?? process.env;
  const out = io?.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = io?.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const home = resolveServerHome(env);
  const registry = new Registry(home);

  const [command, sub, ...rest] = argv;

  try {
    switch (command) {
      case "init": {
        if (registry.isInitialized()) {
          err(`already initialised: ${registry.usersPath} exists`);
          return 1;
        }
        const admin = flagValue(argv, "--admin") ?? "admin";
        registry.init();
        const token = registry.addUser(admin);
        out(`Initialised ${home}.`);
        out("");
        out(tokenBanner(admin, token));
        return 0;
      }

      case "migrate": {
        if (!registry.isInitialized()) {
          err(`no data directory at ${home}; run soil-server init first`);
          return 1;
        }
        const result = registry.migrate();
        if (!result.migrated) {
          out("Nothing to do: this data directory is already up to date.");
          return 0;
        }
        out(
          `Migrated ${home}: ${result.users} user(s) given a stable id, ${result.projects} project(s) rewritten to reference it.`,
        );
        out(
          "Each personal store moved from users/<name> to users/<id>. A username can now be released and reused without carrying anything with it.",
        );
        return 0;
      }

      case "serve": {
        const portRaw = flagValue(argv, "--port");
        const port = portRaw === undefined ? NaN : Number.parseInt(portRaw, 10);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          err("serve needs --port <1-65535> (or 0 for an ephemeral port)");
          return 1;
        }
        if (!registry.isInitialized()) {
          err(`no data directory at ${home}; run soil-server init first`);
          return 1;
        }
        registry.assertCurrent();
        const host = flagValue(argv, "--host") ?? "127.0.0.1";
        // A browser origin the operator vouches for. Loopback origins are
        // answered without being named, so this list stays empty until somebody
        // serves a page from a real host and wants it to reach this server.
        const allowedOrigins = (flagValue(argv, "--allow-origin") ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0);
        const badOrigin = allowedOrigins.find(
          (origin) => !/^https?:\/\/[^/]+$/.test(origin),
        );
        if (badOrigin !== undefined) {
          err(
            `--allow-origin takes origins, not URLs with a path: ${badOrigin} should look like https://handovers.example`,
          );
          return 1;
        }
        const logger = createLogger(env);
        const started = await startServer({
          home,
          port,
          host,
          logger,
          allowedOrigins,
        });
        out(
          `soil-server listening on http://${started.host}:${started.port}, data in ${home}`,
        );
        if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
          out(
            "Bound to localhost only. To serve a network, put TLS in front and pass --host explicitly.",
          );
        } else {
          out(
            "Bound to a non-localhost interface. Put TLS in front of this: tokens travel in headers.",
          );
        }
        if (allowedOrigins.length > 0) {
          out(
            `Browser origins answered besides the loopback ones: ${allowedOrigins.join(", ")}.`,
          );
        }
        logger.log({
          surface: "server",
          action: "listening",
          detail: `${started.host}:${String(started.port)}`,
        });
        // Keep the process alive until the server closes.
        await new Promise<void>((resolve) => {
          started.server.on("close", resolve);
        });
        return 0;
      }

      case "user":
        return userCommand(registry, home, sub, rest, argv, out, err);

      case "project":
        return projectCommand(registry, home, sub, rest, argv, out, err);

      default:
        err(USAGE);
        return command === undefined || command === "help" ? 0 : 1;
    }
  } catch (error) {
    if (error instanceof LockBusyError) {
      err(
        `${error.message}. If no server is running against ${home}, a previous run was killed mid-write and the lock clears itself after 30 seconds.`,
      );
      return 1;
    }
    if (error instanceof RegistryError) {
      err(error.message);
      return 1;
    }
    throw error;
  }
}

function userCommand(
  registry: Registry,
  home: string,
  sub: string | undefined,
  rest: readonly string[],
  argv: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  if (sub === "add") {
    const name = rest[0];
    if (name === undefined || name.startsWith("--")) {
      err("user add needs a username");
      return 1;
    }
    const token = registry.addUser(name);
    const created = registry.findUser(name);
    out(tokenBanner(name, token));
    out("");
    out(`  User id: ${created?.userId ?? "?"}  (stable; survives a rename)`);
    return 0;
  }

  if (sub === "list") {
    const users = registry.listUsers();
    if (users.length === 0) {
      out("No users. Run soil-server init first.");
      return 0;
    }
    for (const user of users) {
      out(`${user.username}  ${user.userId}  (created ${user.createdAt})`);
    }
    return 0;
  }

  if (sub === "rename") {
    const [from, to] = rest;
    if (from === undefined || to === undefined) {
      err("user rename needs <old> <new>");
      return 1;
    }
    const renamed = registry.renameUser(from, to);
    out(
      `Renamed ${from} to ${renamed.username}. User id ${renamed.userId} is unchanged, so their store and every project membership followed them.`,
    );
    return 0;
  }

  if (sub === "remove") {
    const name = rest[0];
    if (name === undefined || name.startsWith("--")) {
      err("user remove needs a username");
      return 1;
    }
    const removed = registry.removeUser(name);
    out(`Removed ${name}. Their token no longer authenticates.`);
    out(
      "They were dropped from every project they belonged to. Handovers they saved into a shared project stay there: a project's knowledge belongs to the project.",
    );
    const store = join(home, "users", removed.userId);
    if (argv.includes("--purge")) {
      rmSync(store, { recursive: true, force: true });
      out(`Purged their personal store at users/${removed.userId}.`);
    } else {
      out(
        `Their personal store is still on disk at users/${removed.userId} and is now unreachable. Delete it yourself, or use --purge next time.`,
      );
      out(
        `The name ${name} is free again, and a new user with that name gets a new id and inherits none of this.`,
      );
    }
    return 0;
  }

  err(USAGE);
  return 1;
}

function projectCommand(
  registry: Registry,
  home: string,
  sub: string | undefined,
  rest: readonly string[],
  argv: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  if (sub === "add") {
    const id = rest[0];
    if (id === undefined || id.startsWith("--")) {
      err("project add needs a project id");
      return 1;
    }
    const membersRaw = flagValue(argv, "--members");
    if (membersRaw === undefined) {
      err("project add needs --members <a,b>");
      return 1;
    }
    const members = membersRaw
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member.length > 0);
    const name = flagValue(argv, "--name");
    const project = registry.addProject(id, members, name);
    out(
      `Created project ${project.id} (${project.name}) with members: ${registry.memberNames(project).join(", ")}`,
    );
    return 0;
  }

  if (sub === "list") {
    const projects = registry.listProjects();
    if (projects.length === 0) {
      out("No projects.");
      return 0;
    }
    for (const project of projects) {
      out(
        `${project.id}  ${project.name}  members: ${registry.memberNames(project).join(", ")}`,
      );
    }
    return 0;
  }

  if (sub === "member") {
    const [action, projectId, username] = rest;
    if (projectId === undefined || username === undefined) {
      err("project member add|remove needs <project-id> <username>");
      return 1;
    }
    if (action === "add") {
      const project = registry.addMember(projectId, username);
      out(
        `${username} is now a member of ${project.id}. They can see every handover already in it.`,
      );
      return 0;
    }
    if (action === "remove") {
      const project = registry.removeMember(projectId, username);
      out(`${username} is no longer a member of ${project.id}.`);
      out(
        "Their access ends with their next request: membership is read from disk every time, so there is no session to expire.",
      );
      out(
        "The project keeps every handover, including the ones they wrote. Their personal store is untouched.",
      );
      return 0;
    }
    err("project member add|remove needs <project-id> <username>");
    return 1;
  }

  if (sub === "remove") {
    const id = rest[0];
    if (id === undefined || id.startsWith("--")) {
      err("project remove needs a project id");
      return 1;
    }
    registry.removeProject(id);
    out(`Removed project ${id}. Nobody can reach it any more.`);
    if (argv.includes("--purge")) {
      rmSync(join(home, "projects", id), { recursive: true, force: true });
      out(`Purged its shared store at projects/${id}.`);
    } else {
      out(
        `Its shared store is still on disk at projects/${id}. Delete it yourself, or use --purge next time.`,
      );
    }
    return 0;
  }

  err(USAGE);
  return 1;
}
