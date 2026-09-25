import PageHeader from "../../components/crm/PageHeader";
import ApolloSourcingApp from "../../components/apollo/SourcingApp";
import { firm } from "../../../firm.config";

export default function ApolloSourcingPage() {
  const segments = firm.segments.map((s) => ({ id: s.id, label: s.label }));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        title="Apollo sourcing"
        subtitle={`Search Apollo for ${firm.segments[0]?.label.toLowerCase() ?? "prospects"} and import the ones worth tracking.`}
      />
      <ApolloSourcingApp segments={segments} />
    </div>
  );
}
