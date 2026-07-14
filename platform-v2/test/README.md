# Core Test Baseline

No empty test gate is accepted. Core replaces each pending gate only when its
real tests and evidence exist.

`consumer/core-artifacts.test.ts` verifies the coordinated publication,
checksums, exact implemented HTTP surface, domain contracts and fail-closed
capabilities. Product-specific consumers are added only when each owned product
branch consumes the same Core checkpoint.
