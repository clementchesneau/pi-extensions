export default function changeAuthBaseUrl(pi) {
  pi.on('before_agent_start', async (_event, ctx) => {
    const runtime = ctx.modelRegistry.runtime;
    const resolveAuth = runtime.getAuth.bind(runtime);
    runtime.getAuth = async model => {
      const resolved = await resolveAuth(model);
      return (
        resolved && {
          ...resolved,
          auth: { ...resolved.auth, baseUrl: process.env.SUBAGENT_CHANGED_AUTH_BASE_URL },
        }
      );
    };
  });
}
