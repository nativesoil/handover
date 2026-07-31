"""The write lock, the same properties the TypeScript reference holds."""

import json
import time

import pytest

from soil_handover import LockBusyError, with_lock


def hold_from_elsewhere(locks, name, holder):
    """Leave behind exactly what another process holding the lock leaves."""
    directory = locks / f"{name}.lock"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "holder.json").write_text(json.dumps(holder), encoding="utf-8")
    return directory


class TestWithLock:
    def test_runs_the_body_and_leaves_nothing_behind(self, tmp_path):
        locks = tmp_path / ".locks"
        assert with_lock(locks, "store", lambda: 42) == 42
        assert not (locks / "store.lock").exists()

    def test_releases_when_the_body_raises(self, tmp_path):
        locks = tmp_path / ".locks"

        def boom():
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            with_lock(locks, "store", boom)
        assert not (locks / "store.lock").exists()

    def test_refuses_rather_than_running_the_body_while_somebody_else_holds_it(
        self, tmp_path
    ):
        locks = tmp_path / ".locks"
        hold_from_elsewhere(
            locks,
            "store",
            {
                "holder": "11111111-1111-4111-8111-111111111111",
                "acquiredAt": int(time.time() * 1000),
                "host": "elsewhere",
                "pid": 1,
            },
        )
        ran = []
        with pytest.raises(LockBusyError):
            with_lock(locks, "store", lambda: ran.append(True), timeout_ms=60)
        # The point of the refusal: nothing was written, not even partly.
        assert ran == []

    def test_does_not_decide_anything_from_a_process_id(self, tmp_path):
        # Two containers on one volume both run as pid 1. A lock whose holder
        # carries *this* process's own pid must still be treated as somebody
        # else's, or a fix that leans on pids being distinct silently opens the
        # race it was meant to close.
        import os

        locks = tmp_path / ".locks"
        hold_from_elsewhere(
            locks,
            "store",
            {
                "holder": "22222222-2222-4222-8222-222222222222",
                "acquiredAt": int(time.time() * 1000),
                "host": "elsewhere",
                "pid": os.getpid(),
            },
        )
        with pytest.raises(LockBusyError):
            with_lock(locks, "store", lambda: None, timeout_ms=60)

    def test_takes_over_a_lock_whose_holder_died(self, tmp_path):
        locks = tmp_path / ".locks"
        hold_from_elsewhere(
            locks,
            "store",
            {
                "holder": "33333333-3333-4333-8333-333333333333",
                "acquiredAt": int(time.time() * 1000) - 120_000,
                "host": "elsewhere",
                "pid": 1,
            },
        )
        assert (
            with_lock(
                locks, "store", lambda: "taken", timeout_ms=500, stale_ms=1_000
            )
            == "taken"
        )

    def test_takes_over_a_lock_directory_whose_owner_died_before_writing_a_holder(
        self, tmp_path
    ):
        # The window between the mkdir and the holder write. Without a fallback
        # this would be a lock nothing could ever break.
        locks = tmp_path / ".locks"
        (locks / "store.lock").mkdir(parents=True)
        assert (
            with_lock(locks, "store", lambda: "taken", timeout_ms=500, stale_ms=0)
            == "taken"
        )

    def test_keeps_different_names_apart(self, tmp_path):
        locks = tmp_path / ".locks"
        hold_from_elsewhere(
            locks,
            "personal-a",
            {
                "holder": "44444444-4444-4444-8444-444444444444",
                "acquiredAt": int(time.time() * 1000),
                "host": "elsewhere",
                "pid": 1,
            },
        )
        # A held personal store must not block a different store's writer.
        assert (
            with_lock(locks, "personal-b", lambda: "fine", timeout_ms=60) == "fine"
        )

    def test_writes_a_random_holder_id_never_a_predictable_one(self, tmp_path):
        locks = tmp_path / ".locks"
        seen = set()

        def peek():
            record = json.loads(
                (locks / "store.lock" / "holder.json").read_text(encoding="utf-8")
            )
            seen.add(record["holder"])

        for _ in range(3):
            with_lock(locks, "store", peek)
        assert len(seen) == 3

    def test_lives_where_every_other_sdk_puts_it(self, tmp_path):
        # The on-disk contract: one store, five SDKs, one lock directory.
        from soil_handover import HandoverStore

        store = HandoverStore(str(tmp_path))
        assert store.locks_dir == tmp_path / ".locks"

    def test_a_name_that_cannot_be_created_fails_at_once_saying_why(self, tmp_path):
        # A create refused for something other than already-exists is treated
        # as contention, because on Windows that is how a name on its way out
        # is reported. That must not swallow a create that will never work: a
        # lock inside a directory that is not there is not a busy lock, and the
        # caller has to be told the difference, immediately and in the
        # platform's own words.
        locks = tmp_path / ".locks"
        started = time.monotonic()
        with pytest.raises(OSError) as caught:
            with_lock(locks, "missing/child", lambda: "never")
        assert not isinstance(caught.value, LockBusyError)
        # Fast, not after the retry budget and not after the acquire timeout.
        assert time.monotonic() - started < 0.5
