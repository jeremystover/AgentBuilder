import { TopNav } from "./components/TopNav";
import { PlaceholderView } from "./components/PlaceholderView";
import { GatherView } from "./components/drilldowns/GatherView";
import { ReviewQueueView } from "./components/drilldowns/ReviewQueueView";
import { TransactionsView } from "./components/drilldowns/TransactionsView";
import { useRoute } from "./router";

export function App() {
  const [route] = useRoute();
  return (
    <div className="h-screen flex flex-col bg-bg-primary text-text-primary overflow-hidden">
      <TopNav />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {route === "gather"       && <GatherView />}
        {route === "review"       && <ReviewQueueView />}
        {route === "transactions" && <TransactionsView />}
        {route === "reporting"    && <PlaceholderView name="Reporting (Phase 2)" />}
        {route === "planning"     && <PlaceholderView name="Planning" />}
        {route === "spending"     && <PlaceholderView name="Spending" />}
        {route === "scenarios"    && <PlaceholderView name="Scenarios" />}
        {route === "settings"     && <PlaceholderView name="Settings" />}
      </div>
    </div>
  );
}
