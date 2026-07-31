# Planned profiles

**This document is non-normative.** Nothing here is part of Soil Handover
Specification v1, and nothing here is required for conformance. It exists so
implementers can see the direction and are not surprised later.

These are named here so implementers know the direction; none of them is
required for conformance with this specification, and none changes how the
sections are read:

- **Artifact references.** A structure for referring to external artifacts
  (repositories, documents, large tool outputs) by identifier, location,
  media type, size and content digest, instead of embedding content. The
  handover carries what an artifact is and why it matters, never large
  payloads.
- **Event profile.** A CloudEvents-compatible envelope for changes over time
  (a handover created, a load performed), for automated systems. The handover
  document stays a frozen snapshot; events are a separate contract.
- **Integrity and signing profile.** A canonicalization rule (an established
  JSON canonicalization scheme, not an ad hoc ordering), a content digest and
  an optional signature, so a regulated consumer can show which state was
  loaded and that it was not altered. Optional by design: plain local use
  never requires keys.
- **Observability conventions.** Recommended semantic attribute names for
  tracing save and load operations through larger systems.

A profile becomes real by being published with fixtures in the conformance
suite, not by being announced.
