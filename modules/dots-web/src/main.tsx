import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "./styles/theme.css";
import { loadAgents, onAgentsChange } from "./store";
import type { WebAgent } from "./types";
import { PairingScreen } from "./pairing/PairingScreen";
import { ChatApp } from "./chat/ChatApp";

/** Sans agent appairé : l'écran du QR code. Sinon : le chat. */
function App() {
  const [agents, setAgents] = useState<WebAgent[]>(loadAgents);
  useEffect(() => onAgentsChange(setAgents), []);
  return agents.length === 0 ? <PairingScreen /> : <ChatApp agents={agents} />;
}

render(<App />, document.getElementById("app")!);
