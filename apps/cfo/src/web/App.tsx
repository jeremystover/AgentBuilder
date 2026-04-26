import { ChatPanel } from "./components/ChatPanel";
import { SnapshotPanel } from "./components/SnapshotPanel";
import { ReviewQueueRail } from "./components/ReviewQueueRail";
import { TopNav } from "./components/TopNav";
import { ReviewQueueView } from "./components/drilldowns/ReviewQueueView";
import { AccountsView } from "./components/drilldowns/AccountsView";
import { TransactionsView } from "./components/drilldowns/TransactionsView";
import { ReportsView } from "./components/drilldowns/ReportsView";
import { ImportsView } from "./components/drilldowns/ImportsView";
import { RulesView } from "./components/drilldowns/RulesView";
import { BudgetView } from "./components/drilldowns/BudgetView";
import { useChat } from "./hooks/useChat";
import { useSnapshot } from "./hooks/useSnapshot";
import { useRoute } from "./router";

export function App() {
  const [route] = useRoute();

  return (
    <div className="h-screen flex flex-col bg-bg-primary text-text-primary overflow-hidden">
      <TopNav />
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {route === "chat"         && <ChatLayout />}
        {route === "review"       && <ReviewQueueView />}
        {route === "accounts"     && <AccountsView />}
        {route === "transactions" && <TransactionsView />}
        {route === "reports"      && <ReportsView />}
        {route === "imports"      && <ImportsView />}
        {route === "rules"        && <RulesView />}
        {route === "budget"       && <BudgetView />}
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
