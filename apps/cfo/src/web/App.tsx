import { TopNav } from "./components/TopNav";
import { PlaceholderView } from "./components/PlaceholderView";
import { GatherView } from "./components/drilldowns/GatherView";
import { ReviewQueueView } from "./components/drilldowns/ReviewQueueView";
import { TransactionsView } from "./components/drilldowns/TransactionsView";
import { ReportsView } from "./components/drilldowns/ReportsView";
import { SpendingView } from "./components/drilldowns/SpendingView";
import { PlansView } from "./components/drilldowns/PlansView";
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
        {route === "reporting"    && <ReportsView />}
        {route === "planning"     && <PlansView />}
        {route === "spending"     && <SpendingView />}
        {route === "scenarios"    && <PlaceholderView name="Scenarios" />}
        {route === "settings"     && <PlaceholderView name="Settings" />}
      </div>
    </div>
  );
}
