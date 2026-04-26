import { Wallet, Menu } from "lucide-react";
import { useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SnapshotPanel } from "./components/SnapshotPanel";
import { ReviewQueueStub } from "./components/ReviewQueueStub";
import { useChat } from "./hooks/useChat";
import { useSnapshot } from "./hooks/useSnapshot";

export function App() {
  const chatH = useChat();
  const snapshotH = useSnapshot();
  const [leftOpen, setLeftOpen] = useState(true);

  return (
    <div className="h-screen flex bg-bg-primary text-text-primary overflow-hidden">
      {/* Left rail — review queue */}
      {leftOpen && (
        <div className="w-72 flex-none border-r border-border bg-bg-surface hidden lg:flex flex-col">
          <ReviewQueueStub />
        </div>
      )}

      {/* Center — chat */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex items-center justify-between border-b border-border bg-bg-surface px-5 py-3">
          <div className="flex items-center gap-3">
            <button
              className="lg:hidden text-text-muted hover:text-text-primary"
              onClick={() => setLeftOpen((o) => !o)}
              aria-label="Toggle review queue"
            >
              <Menu className="w-5 h-5" />
            </button>
            <Wallet className="w-5 h-5 text-accent-primary" />
            <h1 className="text-base font-semibold tracking-tight">CFO</h1>
          </div>
          <div className="flex items-center gap-4 text-xs text-text-muted">
            <a href="/legacy" className="hover:text-text-primary">Legacy UI</a>
            <a href="/logout" className="hover:text-text-primary">Sign out</a>
          </div>
        </header>
        <ChatPanel
          turns={chatH.turns}
          loading={chatH.loading}
          onSend={(m) => void chatH.send(m)}
          onCancel={chatH.cancel}
          onClear={chatH.clear}
        />
      </div>

      {/* Right rail — snapshot */}
      <div className="w-80 flex-none border-l border-border bg-bg-surface hidden md:flex flex-col">
        <SnapshotPanel
          snapshot={snapshotH.snapshot}
          loading={snapshotH.loading}
          error={snapshotH.error}
          onRefresh={() => void snapshotH.refresh()}
        />
      </div>
    </div>
  );
}
