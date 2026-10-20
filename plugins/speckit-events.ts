import tools from "../tools/plugins/speckit-events"

// The empty server entrypoint keeps the shim loadable on OpenCode 1, which reads the server function.
export default { ...tools, server: () => ({}) }