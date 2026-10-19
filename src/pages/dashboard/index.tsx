import MainLayout from "../layout";
import WorkspaceDashboard from "../../components/WorkspaceDashboard";
import { getAuthUser } from "../../api/authStorage";

export default function Dashboard() {
    const authUser = getAuthUser();
    const userName = authUser?.user.name || "Employee";
    const employee = authUser?.userType === "employee" ? authUser.user : null;

    return (
        <MainLayout>
            <WorkspaceDashboard userName={userName} mode="employee" employee={employee} />
        </MainLayout>
    );
}
