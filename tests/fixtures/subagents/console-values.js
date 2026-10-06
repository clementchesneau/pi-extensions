export default function consoleValues(pi) {
  const circular = { label: 'circular-log' };
  circular.self = circular;
  console.log(123n, circular);
  pi.on('input', event => {
    if (event.text.includes('LOG_DURING_RUN')) console.log('mission-log', 456n, circular);
  });
}
