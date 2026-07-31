#!/bin/sh
# Wrapper for buzz-acp's MCP slot. The harness passes BUZZ_ACP_MCP_COMMAND
# as a bare command with an empty argument list (build_mcp_servers in
# block/buzz crates/buzz-acp/src/lib.rs), so the node invocation lives in
# this script instead. Point BUZZ_ACP_MCP_COMMAND at an absolute path to
# this file.
#
# The harness also injects BUZZ_RELAY_URL and BUZZ_PRIVATE_KEY into the
# server's environment; the soil server does not read them. SOIL_HOME can
# be exported before starting buzz-acp to move the store off ~/.soil.
HERE="$(cd "$(dirname "$0")" && pwd)"
exec node "$HERE/../../packages/mcp/bin/soil-mcp.js"
