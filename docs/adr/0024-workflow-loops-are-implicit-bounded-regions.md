# Workflow Loops are implicit bounded regions

Workflow Loops are derived from connections, not manually created steps. Each loop has one entry; loops can be nested or separate, but cannot overlap without nesting. These restrictions make automatic groups and per-loop limits unambiguous without accepting arbitrary cyclic execution.

Max tries includes the first check. Inner counts reset on each outer try. A failed final check stops before corrective work that requires another try; it does not select a success exit. Loop exits are held until the region finishes, and repeat inputs are resolved before current outputs are cleared. Attempts remain recorded.

At the limit, the owner can cancel or allow one more try with optional guidance. Guidance applies to Agent work for that extra try, including its corrective work and nested steps, without changing the fixed Workflow Definition. Grants, counters and guidance are saved with the execution. Restart still requires explicit recovery, as specified in ADR 0023.
