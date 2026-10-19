import { createContext, useContext, type ReactNode } from "react";
const EmployeeView = createContext<((id: string, name: string) => void) | undefined>(undefined);
export function EmployeeQuickViewProvider({ open, children }: { open?: (id: string, name: string) => void; children: ReactNode }) {
  return <EmployeeView.Provider value={open}>{children}</EmployeeView.Provider>;
}
export default function DashboardEmployeeName({ id, name }: { id: string; name: string }) {
  const open = useContext(EmployeeView);
  return open ? <button type="button" className="dw-employee-name" title={`View ${name}`} onClick={(event) => { event.stopPropagation(); open(id, name); }}>{name}</button> : <>{name}</>;
}
