# Fixture: owner digest

The records of an invented session on the public example block `acc` (`examples/acc-sg13g2`, IHP SG13G2): six decisions
(class A, B and C; one waits, one is confirmed, one is reversed), one decision file that cannot be read, six experiments
and one check. All values are invented. `packages/kernel/test/digest.test.ts` reads this directory and compares the
digest with `expected-digest.txt`.
