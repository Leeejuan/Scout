export async function isolateProfiler(mf) {
  const inspector = await mf.getInspectorURL();
  const http = new URL('/json', inspector);
  http.protocol = 'http:';
  const devices = await (await fetch(http, { signal: AbortSignal.timeout(5000) })).json();
  const target = devices.find(device => device.id === 'core:user:scout-test') ??
    devices.find(device => device.title?.includes('scout-test'));
  if (!target?.webSocketDebuggerUrl) throw new Error('Scout workerd inspector target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
    setTimeout(() => reject(new Error('workerd inspector connection timed out')), 5000).unref();
  });
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
  });
  function cdp(method, params = {}) {
    const ticket = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(ticket);
        reject(new Error('workerd inspector did not respond to ' + method));
      }, 5000);
      pending.set(ticket, message => {
        pending.delete(ticket);
        clearTimeout(timeout);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: ticket, method, params }));
    });
  }
  await cdp('Profiler.enable');
  const intervalUs = 100;
  await cdp('Profiler.setSamplingInterval', { interval: intervalUs });
  return {
    async measure(run) {
      await cdp('Profiler.start');
      const result = await run();
      const { profile } = await cdp('Profiler.stop');
      const frames = new Map(profile.nodes.map(node => [node.id, node.callFrame.functionName]));
      // Delayed sample timestamps can include I/O wait. Estimate active JavaScript from sample counts.
      const activeSamples = profile.samples.filter(id => !['(idle)', '(root)', '(program)'].includes(frames.get(id))).length;
      return { ...result, jsSamplingMs: activeSamples * intervalUs / 1000, activeSamples };
    },
    close() { socket.close(); }
  };
}
