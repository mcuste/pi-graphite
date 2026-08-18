import { type GraphiteExtensionApi, registerGraphiteTools } from "./tools.js";

export default function piGraphite(pi: GraphiteExtensionApi): void {
  registerGraphiteTools(pi);
}
