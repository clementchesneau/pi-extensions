export default function blockingShutdown(pi) {
  pi.on(
    'session_shutdown',
    async () =>
      new Promise(() => {
        setInterval(() => {}, 1_000);
      }),
  );
}
