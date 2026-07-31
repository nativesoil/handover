/**
 * Where the server keeps its data.
 *
 * One directory holds everything: the user registry, the project registry,
 * and one handover store per user and per project. `SOIL_SERVER_HOME`
 * overrides the root, which is how the tests run without touching a real
 * home directory. The layout is plain JSON files all the way down, in the
 * same on-disk format as the local `~/.soil` store, so any file here can be
 * copied out and read anywhere.
 *
 *   ~/.soil-server/
 *     users.json                the users and their token hashes
 *     projects.json             the projects and their members
 *     users/<name>/             one personal store per user
 *       index.json
 *       handovers/001.json
 *     projects/<id>/            one shared store per project
 *       index.json
 *       handovers/001.json
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the server data root: `SOIL_SERVER_HOME`, else `~/.soil-server`. */
export function resolveServerHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env["SOIL_SERVER_HOME"];
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  return join(homedir(), ".soil-server");
}
