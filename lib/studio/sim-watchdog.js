'use strict';
// Preloaded (node -r) into the simulator's engine child. When the parent that holds the IPC channel dies, the
// channel closes and the child exits instead of being orphaned.
process.on('disconnect', () => process.exit(0));
