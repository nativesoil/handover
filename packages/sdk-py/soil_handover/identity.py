"""Handover identity: the ``handoverId``.

Every stored handover carries one globally unique id, a UUIDv7 (RFC 9562).
It is assigned by the writer at store time when the document does not
already carry one; the extraction recipe never asks a model to invent an
id, because an id a model makes up is an id two documents can share.

The id is opaque. It is never derived from the document's content, never
reused, and carries no meaning beyond identity: the timestamp embedded in a
UUIDv7 is an implementation detail of how uniqueness is generated, not a
fact a reader may lean on. A byte-for-byte copy of a handover keeps its
handoverId; a new capture, even of the same project a minute later, gets a
new one; migration never changes it.

The local ``#NNN`` code is a different thing entirely: a short human handle
assigned by one store, for typing. Two stores can both hold a ``#001``
without any identity collision, because identity lives here.

Mirrors ``packages/sdk-ts/src/identity.ts``. Standard library only: the
UUIDv7 layout is written out by hand because ``uuid.uuid7`` is not available
on every supported Python version.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

# The shape of a handoverId: canonical lowercase UUID text, 8-4-4-4-12 hex.
#
# The pattern accepts any UUID version on purpose. The official writers emit
# UUIDv7, but a reader treats the id as opaque, so it does not police which
# version another writer chose.
HANDOVER_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def is_handover_id(value: Any) -> bool:
    """Does this value have the shape of a ``handoverId``?"""
    return isinstance(value, str) and HANDOVER_ID_PATTERN.match(value) is not None


def uuidv7(now: datetime | None = None) -> str:
    """Generate a UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then the
    version and variant bits, then 74 random bits.

    ``now`` exists for tests; production callers let it default. The
    randomness comes from the platform CSPRNG, and nothing about the result
    is derived from any document.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    ms = int(now.timestamp() * 1000)

    data = bytearray(os.urandom(16))
    data[0:6] = ms.to_bytes(6, "big")
    data[6] = (data[6] & 0x0F) | 0x70
    data[8] = (data[8] & 0x3F) | 0x80

    hex_text = data.hex()
    return "-".join(
        (
            hex_text[0:8],
            hex_text[8:12],
            hex_text[12:16],
            hex_text[16:20],
            hex_text[20:32],
        )
    )
