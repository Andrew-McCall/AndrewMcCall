// The notes page moved into `notes/` when it grew from a form into a vault.
// This stays as the router's entry point so the route table and the
// `disposeNotes` teardown hook in main.ts don't need to know.

export { default, disposeNotes } from "./notes";
