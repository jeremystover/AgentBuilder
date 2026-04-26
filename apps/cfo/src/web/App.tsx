import { ChatPanel } from "./components/ChatPanel";
import { SnapshotPanel } from "./components/SnapshotPanel";
import { ReviewQueueRail } from "./components/ReviewQueueRail";
import { TopNav } from "./components/TopNav";
import { ReviewQueueView } from "./components/drilldowns/ReviewQueueView";
import { AccountsView } from "./components/drilldowns/AccountsView";
import { TransactionsView } from "./components/drilldowns/TransactionsView";
import { useChat } from "./hooks/useChat";
import { useSnapshot } from "./hooks/useSnapshot";
import { useRoute } from "./router";

export function App() {
  const [route] = useRoute();

  return (
    <div className="h-screen flex flex-col bg-bg-primary text-text-primary overflow-hidden">
      <TopNav />
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {route === "chat" && <ChatLayout />}
        {route === "review" && <ReviewQueueView />}
        {route === "accounts" && <AccountsView />}
        {route === "transactions" && <TransactionsView />}
        {route !== "chat" && route !== "review" && route !== "accounts" && route !== "transactions" && (
          <ComingSoon route={route} />
        )}
      </div>
    </div>
  );
}

function ChatLayout() {
  const chatH = useChat();
  const snapshotH = useSnapshot();
  return (
    <div className="h-full flex">
      <div className="w-72 flex-none border-r border-border bg-bg-surface hidden lg:flex flex-col">
        <ReviewQueueRail />
      </div>
      <ChatPanel
        turns={chatH.turns}
        loading={chatH.loading}
        onSend={(m) => void chatH.send(m)}
        onCancel={chatH.cancel}
        onClear={chatH.clear}
      />
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

function ComingSoon({ route }: { route: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-md text-center">
        <h2 className="text-lg font-semibold text-text-primary capitalize mb-2">{route}</h2>
        <p className="text-sm text-text-muted">
          Not ported yet — head to <a className="text-accent-primary hover:underline" href="/legacy">the legacy UI</a> for now.
        </p>
      </div>
    </div>
  );
}
