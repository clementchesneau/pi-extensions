export default function blockingSyncShutdown(pi) {
  pi.on('session_shutdown', () => {
    while (true) {
      // Block the event loop on purpose.
    }
  });
}
