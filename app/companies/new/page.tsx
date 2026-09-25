import PageHeader from "../../components/crm/PageHeader";
import CompanyForm from "../../components/crm/CompanyForm";
import { firm } from "../../../firm.config";

export default function NewCompanyPage() {
  return (
    <div className="max-w-2xl">
      <PageHeader title="New company" subtitle="Add a company to the pipeline universe." />
      <div className="card p-6">
        <CompanyForm segments={firm.segments} />
      </div>
    </div>
  );
}
