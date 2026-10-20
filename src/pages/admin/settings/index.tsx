import { Fragment, type FormEvent } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiAlertTriangle, FiArchive, FiCheck, FiChevronDown, FiCreditCard, FiDroplet, FiEdit2, FiGitBranch, FiPlus, FiSave, FiShield, FiSliders, FiTag, FiTool, FiX } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { archiveRole, createRole, getRoles, updateRole, type Role, type RoleInput } from "../../../api/roles";
import {
    archiveBranch,
    createBranch,
    getBranches,
    updateBranch,
    type Branch,
    type BranchInput,
} from "../../../api/branches";
import { archiveTool, createTool, getTools, updateTool, type Tool, type ToolInput } from "../../../api/tools";
import { getFeatures, updateFeature, type FeatureFlag } from "../../../api/features";
import {
    archiveProductCategory,
    createProductCategory,
    getProductCategories,
    updateProductCategory,
    type ProductCategory,
    type ProductCategoryInput,
} from "../../../api/productCategories";
import { createBusiness, getBusinesses, updateBusinessName } from "../../../api/businesses";
import {
    currencyOptions,
    attendanceTimeZoneOptions,
    getSystemSettings,
    payrollBillingCycleOptions,
    updateSystemSettings,
    type CurrencyCode,
    type PayrollBillingCycle,
} from "../../../api/systemSettings";
import { DataTablePagination } from "../../../components/admin/DataTable";
import { setAppTheme } from "../../../lib/appTheme";
import { emitToast } from "../../../lib/toast";
import { themeOptions, type ThemeKey } from "../../../lib/themes";
import { attendanceDurationModelEnabled } from "../../../api/attendanceSession";
import AttendancePolicyEditor from "../../../components/AttendancePolicyEditor";

type SettingsTab = "Businesses" | "Departments" | "Branches" | "Tools" | "Product Categories" | "Features" | "Themes" | "System";

const emptyRole: RoleInput = { department: "", name: "", branch: "All branches", description: "" };
const emptyBranch: BranchInput = { name: "", company: "Assistly", location: "" };
const emptyTool: ToolInput = { name: "", link: "", branches: [] };
const emptyProductCategory: ProductCategoryInput = { name: "", description: "" };
const systemSettingCount = currencyOptions.length + 13 - (attendanceDurationModelEnabled ? 2 : 0);

export default function AdminSettings() {
    const queryClient = useQueryClient();
    const [activeTab, setActiveTab] = useState<SettingsTab>("Businesses");
    const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
    const [isBusinessModalOpen, setIsBusinessModalOpen] = useState(false);
    const [isBranchModalOpen, setIsBranchModalOpen] = useState(false);
    const [isToolModalOpen, setIsToolModalOpen] = useState(false);
    const [isProductCategoryModalOpen, setIsProductCategoryModalOpen] = useState(false);
    const [isToolBranchDropdownOpen, setIsToolBranchDropdownOpen] = useState(false);
    const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
    const [editingBranchId, setEditingBranchId] = useState<string | null>(null);
    const [editingToolId, setEditingToolId] = useState<string | null>(null);
    const [editingProductCategoryId, setEditingProductCategoryId] = useState<string | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<{ label: string; type: SettingsTab; onConfirm: () => void } | null>(null);
    const [roleForm, setRoleForm] = useState<RoleInput>(emptyRole);
    const [branchForm, setBranchForm] = useState<BranchInput>(emptyBranch);
    const [toolForm, setToolForm] = useState<ToolInput>(emptyTool);
    const [productCategoryForm, setProductCategoryForm] = useState<ProductCategoryInput>(emptyProductCategory);
    const [businessForm, setBusinessForm] = useState({ name: "" });
    const [businessNameDrafts, setBusinessNameDrafts] = useState<Record<string, string>>({});
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    const { data: roles = EMPTY_QUERY_ROWS, isLoading: rolesLoading, isError: rolesError } = useQuery({
        queryKey: ["roles"],
        queryFn: getRoles,
    });
    const { data: branches = EMPTY_QUERY_ROWS, isLoading: branchesLoading, isError: branchesError } = useQuery({
        queryKey: ["branches"],
        queryFn: getBranches,
    });
    const { data: tools = EMPTY_QUERY_ROWS, isLoading: toolsLoading, isError: toolsError } = useQuery({
        queryKey: ["tools"],
        queryFn: getTools,
    });
    const { data: productCategories = EMPTY_QUERY_ROWS, isLoading: productCategoriesLoading, isError: productCategoriesError } = useQuery({
        queryKey: ["product-categories"],
        queryFn: getProductCategories,
    });
    const { data: features = EMPTY_QUERY_ROWS, isLoading: featuresLoading, isError: featuresError } = useQuery({
        queryKey: ["features"],
        queryFn: getFeatures,
    });
    const { data: businesses = EMPTY_QUERY_ROWS, isLoading: businessesLoading, isError: businessesError } = useQuery({
        queryKey: ["businesses"],
        queryFn: getBusinesses,
    });
    const { data: systemSettings, isLoading: systemSettingsLoading, isError: systemSettingsError } = useQuery({
        queryKey: ["system-settings"],
        queryFn: getSystemSettings,
    });
    const cutoffDay = (value: number | undefined, fallback: number) => Math.min(Math.max(Math.round(value ?? fallback), 1), 31);
    const firstCutoffStartDay = cutoffDay(systemSettings?.payrollFirstCutoffStartDay, 6);
    const firstCutoffEndDay = cutoffDay(systemSettings?.payrollFirstCutoffEndDay, 20);
    const firstCutoffPayDay = cutoffDay(systemSettings?.payrollFirstCutoffPayDay, 25);
    const secondCutoffStartDay = cutoffDay(systemSettings?.payrollSecondCutoffStartDay, 21);
    const secondCutoffEndDay = cutoffDay(systemSettings?.payrollSecondCutoffEndDay, 5);
    const secondCutoffPayDay = cutoffDay(systemSettings?.payrollSecondCutoffPayDay, 10);

    const invalidateRoles = () => queryClient.invalidateQueries({ queryKey: ["roles"] });
    const invalidateBranches = () => queryClient.invalidateQueries({ queryKey: ["branches"] });
    const invalidateTools = () => queryClient.invalidateQueries({ queryKey: ["tools"] });
    const invalidateProductCategories = () => queryClient.invalidateQueries({ queryKey: ["product-categories"] });
    const invalidateFeatures = () => queryClient.invalidateQueries({ queryKey: ["features"] });
    const invalidateBusinesses = () => queryClient.invalidateQueries({ queryKey: ["businesses"] });
    const invalidateSystemSettings = () => queryClient.invalidateQueries({ queryKey: ["system-settings"] });

    const createRoleMutation = useMutation({ mutationFn: createRole, onSuccess: invalidateRoles });
    const updateRoleMutation = useMutation({
        mutationFn: ({ id, role }: { id: string; role: RoleInput }) => updateRole(id, role),
        onSuccess: invalidateRoles,
    });
    const archiveRoleMutation = useMutation({ mutationFn: archiveRole, onSuccess: invalidateRoles });

    const createBranchMutation = useMutation({ mutationFn: createBranch, onSuccess: invalidateBranches });
    const updateBranchMutation = useMutation({
        mutationFn: ({ id, branch }: { id: string; branch: BranchInput }) => updateBranch(id, branch),
        onSuccess: invalidateBranches,
    });
    const archiveBranchMutation = useMutation({ mutationFn: archiveBranch, onSuccess: invalidateBranches });
    const createToolMutation = useMutation({ mutationFn: createTool, onSuccess: invalidateTools });
    const updateToolMutation = useMutation({
        mutationFn: ({ id, tool }: { id: string; tool: ToolInput }) => updateTool(id, tool),
        onSuccess: invalidateTools,
    });
    const archiveToolMutation = useMutation({ mutationFn: archiveTool, onSuccess: invalidateTools });
    const createProductCategoryMutation = useMutation({ mutationFn: createProductCategory, onSuccess: invalidateProductCategories });
    const updateProductCategoryMutation = useMutation({
        mutationFn: ({ id, category }: { id: string; category: ProductCategoryInput }) => updateProductCategory(id, category),
        onSuccess: invalidateProductCategories,
    });
    const archiveProductCategoryMutation = useMutation({ mutationFn: archiveProductCategory, onSuccess: invalidateProductCategories });
    const updateFeatureMutation = useMutation({
        mutationFn: ({ feature }: { feature: FeatureFlag }) =>
            updateFeature(feature.key, {
                adminEnabled: feature.adminEnabled,
                employeeEnabled: feature.employeeEnabled,
            }),
        onSuccess: invalidateFeatures,
    });
    const updateBusinessNameMutation = useMutation({
        mutationFn: ({ id, name }: { id: string; name: string }) => updateBusinessName(id, name),
        onSuccess: (business) => {
            setBusinessNameDrafts((drafts) => ({ ...drafts, [business.id]: business.name }));
            invalidateBusinesses();
        },
    });
    const createBusinessMutation = useMutation({
        mutationFn: ({ name }: { name: string }) => createBusiness(name),
        onSuccess: (business) => {
            setBusinessNameDrafts((drafts) => ({ ...drafts, [business.id]: business.name }));
            invalidateBusinesses();
            setIsBusinessModalOpen(false);
            setBusinessForm({ name: "" });
            emitToast({ tone: "success", message: `${business.name} was created.` });
        },
        onError: (error) => {
            emitToast({
                tone: "error",
                message: error instanceof Error ? error.message : "Unable to create business.",
            });
        },
    });
    const updateSystemSettingsMutation = useMutation({
        mutationFn: updateSystemSettings,
        onSuccess: (settings) => {
            setAppTheme(settings.themeKey, { userOverride: false });
            invalidateSystemSettings();
        },
    });

    const [previousBusinessNames, setPreviousBusinessNames] = useState<readonly unknown[] | null>(null);
    const businessNamesInputs = [businesses];
    if (previousBusinessNames === null || businessNamesInputs.some((input, index) => !Object.is(input, previousBusinessNames[index]))) {
        setPreviousBusinessNames(businessNamesInputs);
        (() => {
            setBusinessNameDrafts(Object.fromEntries(businesses.map((business) => [business.id, business.name])));
        })();
    }

    const openAddBusinessModal = () => {
        setBusinessForm({ name: "" });
        setIsBusinessModalOpen(true);
    };

    const closeBusinessModal = () => {
        setIsBusinessModalOpen(false);
        setBusinessForm({ name: "" });
    };

    const openAddRoleModal = () => {
        setEditingRoleId(null);
        setRoleForm(emptyRole);
        setIsRoleModalOpen(true);
    };

    const openEditRoleModal = (role: Role) => {
        setEditingRoleId(role._id);
        setRoleForm({
            department: role.department || "General",
            name: role.name,
            branch: role.branch || "All branches",
            description: role.description,
        });
        setIsRoleModalOpen(true);
    };

    const closeRoleModal = () => {
        setIsRoleModalOpen(false);
        setEditingRoleId(null);
        setRoleForm(emptyRole);
    };

    const openAddBranchModal = () => {
        setEditingBranchId(null);
        setBranchForm(emptyBranch);
        setIsBranchModalOpen(true);
    };

    const openEditBranchModal = (branch: Branch) => {
        setEditingBranchId(branch._id);
        setBranchForm({ name: branch.name, company: branch.company, location: branch.location });
        setIsBranchModalOpen(true);
    };

    const closeBranchModal = () => {
        setIsBranchModalOpen(false);
        setEditingBranchId(null);
        setBranchForm(emptyBranch);
    };

    const openAddToolModal = () => {
        setEditingToolId(null);
        setToolForm(emptyTool);
        setIsToolModalOpen(true);
    };

    const openEditToolModal = (tool: Tool) => {
        setEditingToolId(tool._id);
        setToolForm({ name: tool.name, link: tool.link, branches: tool.branches || [] });
        setIsToolModalOpen(true);
    };

    const closeToolModal = () => {
        setIsToolModalOpen(false);
        setIsToolBranchDropdownOpen(false);
        setEditingToolId(null);
        setToolForm(emptyTool);
    };

    const openAddProductCategoryModal = () => {
        setEditingProductCategoryId(null);
        setProductCategoryForm(emptyProductCategory);
        setIsProductCategoryModalOpen(true);
    };

    const openEditProductCategoryModal = (category: ProductCategory) => {
        setEditingProductCategoryId(category._id);
        setProductCategoryForm({ name: category.name, description: category.description });
        setIsProductCategoryModalOpen(true);
    };

    const closeProductCategoryModal = () => {
        setIsProductCategoryModalOpen(false);
        setEditingProductCategoryId(null);
        setProductCategoryForm(emptyProductCategory);
    };

    const handleSaveRole = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!roleForm.department.trim() || !roleForm.name.trim()) return;

        if (editingRoleId) {
            updateRoleMutation.mutate({ id: editingRoleId, role: roleForm });
        } else {
            createRoleMutation.mutate(roleForm);
        }

        closeRoleModal();
    };

    const handleSaveBranch = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!branchForm.name.trim()) return;

        if (editingBranchId) {
            updateBranchMutation.mutate({ id: editingBranchId, branch: branchForm });
        } else {
            createBranchMutation.mutate(branchForm);
        }

        closeBranchModal();
    };

    const handleSaveTool = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!toolForm.name.trim()) return;

        if (editingToolId) {
            updateToolMutation.mutate({ id: editingToolId, tool: toolForm });
        } else {
            createToolMutation.mutate(toolForm);
        }

        closeToolModal();
    };

    const handleSaveProductCategory = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!productCategoryForm.name.trim()) return;

        if (editingProductCategoryId) {
            updateProductCategoryMutation.mutate({ id: editingProductCategoryId, category: productCategoryForm });
        } else {
            createProductCategoryMutation.mutate(productCategoryForm);
        }

        closeProductCategoryModal();
    };

    const handleCreateBusiness = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const name = businessForm.name.trim();

        if (!name) return;

        createBusinessMutation.mutate({ name });
    };

    const handleSaveBusinessName = (businessId: string) => {
        const business = businesses.find((item) => item.id === businessId);
        const name = (businessNameDrafts[businessId] || "").trim();

        if (!business || !name || name === business.name) {
            return;
        }

        updateBusinessNameMutation.mutate({ id: businessId, name });
    };

    const openCurrentAddModal = () => {
        if (activeTab === "Businesses") openAddBusinessModal();
        if (activeTab === "Departments") openAddRoleModal();
        if (activeTab === "Branches") openAddBranchModal();
        if (activeTab === "Tools") openAddToolModal();
        if (activeTab === "Product Categories") openAddProductCategoryModal();
    };

    const openDeletePrompt = (target: { label: string; type: SettingsTab; onConfirm: () => void }) => {
        setDeleteTarget(target);
    };

    const closeDeletePrompt = () => {
        setDeleteTarget(null);
    };

    const confirmDelete = () => {
        deleteTarget?.onConfirm();
        closeDeletePrompt();
    };

    const paginateRows = <T,>(rows: T[]) => rows.slice((page - 1) * pageSize, page * pageSize);
    const activeTotalItems =
        activeTab === "Businesses"
            ? businesses.length
            : activeTab === "Departments"
                ? roles.length
                : activeTab === "Branches"
                    ? branches.length
                    : activeTab === "Tools"
                        ? tools.length
                        : activeTab === "Product Categories"
                            ? productCategories.length
                            : activeTab === "Features"
                                ? features.length
                                : activeTab === "Themes"
                                    ? themeOptions.length
                                    : systemSettingCount;
    const branchGroupNames = branches.length ? branches.map((branch) => branch.name) : ["Branches"];
    const expandedRoles = roles.flatMap((role) => {
        if (role.branch && role.branch !== "All branches") return [{ groupBranch: role.branch, role }];
        return branchGroupNames.map((groupBranch) => ({ groupBranch, role }));
    });
    const sortedRoles = [...expandedRoles].sort((left, right) => {
        const leftBranch = left.groupBranch;
        const rightBranch = right.groupBranch;
        return (
            leftBranch.localeCompare(rightBranch) ||
            (left.role.department || "General").localeCompare(right.role.department || "General") ||
            left.role.name.localeCompare(right.role.name)
        );
    });
    const visibleRoles = paginateRows(sortedRoles);
    const groupedVisibleRoles = visibleRoles.reduce<Array<{ branch: string; roles: Array<{ role: Role; displayBranch: string }> }>>((groups, item) => {
        const branch = item.groupBranch;
        const existingGroup = groups.find((group) => group.branch === branch);
        const roleItem = { role: item.role, displayBranch: item.role.branch === "All branches" || !item.role.branch ? item.groupBranch : item.role.branch };

        if (existingGroup) {
            existingGroup.roles.push(roleItem);
        } else {
            groups.push({ branch, roles: [roleItem] });
        }

        return groups;
    }, []);
    const visibleBranches = paginateRows(branches);
    const visibleBusinesses = paginateRows(businesses);
    const visibleTools = paginateRows(tools);
    const visibleProductCategories = paginateRows(productCategories);
    const visibleFeatures = paginateRows(features);
    const visibleThemes = paginateRows(themeOptions);

    const [previousSettingsTab, setPreviousSettingsTab] = useState<readonly unknown[] | null>(null);
    const settingsTabInputs = [activeTab];
    if (previousSettingsTab === null || settingsTabInputs.some((input, index) => !Object.is(input, previousSettingsTab[index]))) {
        setPreviousSettingsTab(settingsTabInputs);
        (() => {
            setPage(1);
        })();
    }

    const [previousSettingsPageLimit, setPreviousSettingsPageLimit] = useState<readonly unknown[] | null>(null);
    const settingsPageLimitInputs = [activeTotalItems, pageSize];
    if (previousSettingsPageLimit === null || settingsPageLimitInputs.some((input, index) => !Object.is(input, previousSettingsPageLimit[index]))) {
        setPreviousSettingsPageLimit(settingsPageLimitInputs);
        (() => {
            setPage((currentPage) => Math.min(currentPage, Math.max(1, Math.ceil(activeTotalItems / pageSize))));
        })();
    }

    return (
        <AdminLayout>
            <section className="theme-surface-bg min-h-[calc(100vh-8.5rem)] rounded-lg border border-white/10">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
                    <div>
                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Admin Settings</p>
                        <h2 className="mt-1 text-xl font-semibold text-white">{activeTab === "Themes" ? "Employee themes" : activeTab}</h2>
                        {activeTab === "Themes" && <p className="mt-1 text-sm text-slate-600">Admin appearance: Light</p>}
                    </div>

                    {activeTab !== "Features" && activeTab !== "Themes" && activeTab !== "System" && (
                        <button
                            className="theme-primary-bg flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-white transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_60%,transparent)]"
                            type="button"
                            onClick={openCurrentAddModal}
                        >
                            <FiPlus className="size-4" aria-hidden="true" />
                            Add {activeTab === "Businesses" ? "Business" : activeTab === "Departments" ? "Department" : activeTab === "Branches" ? "Branch" : activeTab === "Tools" ? "Tool" : "Category"}
                        </button>
                    )}
                </div>

                <div className="border-b border-slate-300 px-4 pt-3">
                    <div className="flex gap-2">
                        {(["Businesses", "Branches", "Departments", "Tools", "Product Categories", "Features", "Themes", "System"] as const).map((tab) => {
                            const Icon =
                                tab === "Businesses"
                                    ? FiGitBranch
                                    : tab === "Departments"
                                        ? FiShield
                                        : tab === "Branches"
                                            ? FiGitBranch
                                            : tab === "Tools"
                                                ? FiTool
                                                : tab === "Product Categories"
                                                    ? FiTag
                                                    : tab === "Features"
                                                        ? FiSliders
                                                        : tab === "Themes"
                                                            ? FiDroplet
                                                            : FiCreditCard;

                            return (
                                <button
                                    key={tab}
                                    className={[
                                        "flex h-11 items-center gap-2 px-4 text-sm font-semibold !text-black transition hover:!text-black",
                                        activeTab === tab
                                            ? "theme-primary-soft-bg border-b-2 border-[var(--primary)]"
                                            : "hover:bg-slate-100",
                                    ].join(" ")}
                                    type="button"
                                    onClick={() => setActiveTab(tab)}
                                >
                                    <Icon className="size-4" aria-hidden="true" />
                                    {tab}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="p-4">
                    <div className="theme-surface-bg flex h-[calc(100vh-19rem)] min-h-[30rem] flex-col overflow-hidden rounded-lg border border-white/10 shadow-2xl shadow-black/20">
                        <div className="content-scroll min-h-0 flex-1 overflow-auto bg-[linear-gradient(to_bottom,var(--panel-bg)_0,var(--panel-bg)_3.15rem,transparent_3.15rem)] [scrollbar-gutter:stable]">
                            <table className="w-full min-w-[62rem] table-fixed border-separate border-spacing-0 text-left">
                                <thead className="sticky top-0 z-10 bg-[var(--panel-bg)] text-[0.74rem] font-medium text-white/65 shadow-[12px_0_0_var(--panel-bg)]">
                                    {activeTab === "Businesses" ? (
                                        <tr>
                                            <th className="w-[34%] px-5 py-4">Business Name</th>
                                            <th className="w-[24%] px-5 py-4">Business ID</th>
                                            <th className="w-[18%] px-5 py-4">Default</th>
                                            <th className="w-[24%] px-5 py-4">Action</th>
                                        </tr>
                                    ) : activeTab === "Departments" ? (
                                        <tr>
                                            <th className="w-[22%] px-5 py-4">Department</th>
                                            <th className="w-[22%] px-5 py-4">Role</th>
                                            <th className="w-[20%] px-5 py-4">Branch</th>
                                            <th className="w-[20%] px-5 py-4">Description</th>
                                            <th className="w-[16%] px-5 py-4 text-right">Actions</th>
                                        </tr>
                                    ) : activeTab === "Branches" ? (
                                        <tr>
                                            <th className="w-[24%] px-5 py-4">Branch</th>
                                            <th className="w-[24%] px-5 py-4">Company</th>
                                            <th className="w-[36%] px-5 py-4">Location</th>
                                            <th className="w-[16%] px-5 py-4 text-right">Actions</th>
                                        </tr>
                                    ) : activeTab === "Tools" ? (
                                        <tr>
                                            <th className="w-[22%] px-5 py-4">Tool</th>
                                            <th className="w-[34%] px-5 py-4">Link</th>
                                            <th className="w-[28%] px-5 py-4">Branches</th>
                                            <th className="w-[16%] px-5 py-4 text-right">Actions</th>
                                        </tr>
                                    ) : activeTab === "Product Categories" ? (
                                        <tr>
                                            <th className="w-[28%] px-5 py-4">Category</th>
                                            <th className="w-[56%] px-5 py-4">Description</th>
                                            <th className="w-[16%] px-5 py-4 text-right">Actions</th>
                                        </tr>
                                    ) : activeTab === "Features" ? (
                                        <tr>
                                            <th className="w-[24%] px-5 py-4">Feature</th>
                                            <th className="w-[48%] px-5 py-4">Description</th>
                                            <th className="w-[14%] px-5 py-4 text-center">Admin</th>
                                            <th className="w-[14%] px-5 py-4 text-center">Employee</th>
                                        </tr>
                                    ) : activeTab === "Themes" ? (
                                        <tr>
                                            <th className="w-[30%] px-5 py-4">Employee Theme</th>
                                            <th className="w-[18%] px-5 py-4">Basis</th>
                                            <th className="w-[22%] px-5 py-4">Palette</th>
                                            <th className="w-[30%] px-5 py-4">Action</th>
                                        </tr>
                                    ) : (
                                        <tr>
                                            <th className="w-[28%] px-5 py-4">Setting</th>
                                            <th className="w-[18%] px-5 py-4">Current</th>
                                            <th className="w-[18%] px-5 py-4">Type</th>
                                            <th className="w-[36%] px-5 py-4">Action</th>
                                        </tr>
                                    )}
                                </thead>
                                <tbody className="divide-y divide-white/10">
                                    {activeTab === "Businesses" ? (
                                        <>
                                            {businessesLoading && <EmptyRow colSpan={4} text="Loading businesses..." />}
                                            {businessesError && <EmptyRow colSpan={4} text="Unable to load businesses." danger />}
                                            {!businessesLoading && !businessesError && businesses.length === 0 && <EmptyRow colSpan={4} text="No businesses configured." />}
                                            {visibleBusinesses.map((business) => {
                                                const draftName = businessNameDrafts[business.id] ?? business.name;
                                                const nextName = draftName.trim();
                                                const isDirty = Boolean(nextName) && nextName !== business.name;
                                                const isSaving =
                                                    updateBusinessNameMutation.isPending &&
                                                    updateBusinessNameMutation.variables?.id === business.id;

                                                return (
                                                    <tr key={business.id} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4">
                                                            <input
                                                                className="h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                value={draftName}
                                                                disabled={isSaving}
                                                                onChange={(event) =>
                                                                    setBusinessNameDrafts((drafts) => ({
                                                                        ...drafts,
                                                                        [business.id]: event.target.value,
                                                                    }))
                                                                }
                                                                onKeyDown={(event) => {
                                                                    if (event.key === "Enter") {
                                                                        handleSaveBusinessName(business.id);
                                                                    }
                                                                }}
                                                            />
                                                        </td>
                                                        <td className="px-5 py-4 font-mono text-xs text-white/55">{business.id}</td>
                                                        <td className="px-5 py-4 text-white/60">{business.isDefault ? "Yes" : "No"}</td>
                                                        <td className="px-5 py-4">
                                                            <button
                                                                className="theme-primary-bg inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                                                                type="button"
                                                                disabled={!isDirty || isSaving}
                                                                onClick={() => handleSaveBusinessName(business.id)}
                                                            >
                                                                <FiSave className="size-4" aria-hidden="true" />
                                                                {isSaving ? "Saving" : "Save"}
                                                            </button>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </>
                                    ) : activeTab === "Departments" ? (
                                        <>
                                            {rolesLoading && <EmptyRow colSpan={5} text="Loading departments..." />}
                                            {rolesError && <EmptyRow colSpan={5} text="Unable to load departments." danger />}
                                            {!rolesLoading && !rolesError && roles.length === 0 && <EmptyRow colSpan={5} text="No departments yet." />}
                                            {groupedVisibleRoles.map((group) => (
                                                <Fragment key={group.branch}>
                                                    <tr className="bg-[#0d111a] text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-white/38">
                                                        <td className="px-5 py-3" colSpan={5}>
                                                            <div className="flex items-center gap-3">
                                                                <span className="h-px flex-1 bg-white/10" />
                                                                <span>{group.branch}</span>
                                                                <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[0.62rem] text-white/45">
                                                                    {group.roles.length} role{group.roles.length === 1 ? "" : "s"}
                                                                </span>
                                                                <span className="h-px flex-1 bg-white/10" />
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    {group.roles.map(({ role, displayBranch }) => (
                                                        <tr key={role._id} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                            <td className="px-5 py-4 font-semibold text-white">{role.department || "General"}</td>
                                                            <td className="px-5 py-4 text-white/75">{role.name}</td>
                                                            <td className="truncate px-5 py-4 text-white/60">{displayBranch}</td>
                                                            <td className="truncate px-5 py-4 text-white/55">{role.description || "No description"}</td>
                                                            <td className="px-5 py-4">
                                                                <RowActions
                                                                    label={role.name}
                                                                    onEdit={() => openEditRoleModal(role)}
                                                                    onArchive={() =>
                                                                        openDeletePrompt({
                                                                            label: role.name,
                                                                            type: "Departments",
                                                                            onConfirm: () => archiveRoleMutation.mutate(role._id),
                                                                        })
                                                                    }
                                                                />
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </Fragment>
                                            ))}
                                        </>
                                    ) : activeTab === "Branches" ? (
                                        <>
                                            {branchesLoading && <EmptyRow colSpan={4} text="Loading branches..." />}
                                            {branchesError && <EmptyRow colSpan={4} text="Unable to load branches." danger />}
                                            {!branchesLoading && !branchesError && branches.length === 0 && <EmptyRow colSpan={4} text="No branches yet." />}
                                            {visibleBranches.map((branch) => (
                                                <tr key={branch._id} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                    <td className="px-5 py-4 font-semibold text-white">{branch.name}</td>
                                                    <td className="truncate px-5 py-4 text-white/60">{branch.company}</td>
                                                    <td className="truncate px-5 py-4 text-white/55">{branch.location || "No location"}</td>
                                                    <td className="px-5 py-4">
                                                        <RowActions
                                                            label={branch.name}
                                                            onEdit={() => openEditBranchModal(branch)}
                                                            onArchive={() =>
                                                                openDeletePrompt({
                                                                    label: branch.name,
                                                                    type: "Branches",
                                                                    onConfirm: () => archiveBranchMutation.mutate(branch._id),
                                                                })
                                                            }
                                                        />
                                                    </td>
                                                </tr>
                                            ))}
                                        </>
                                    ) : activeTab === "Tools" ? (
                                        <>
                                            {toolsLoading && <EmptyRow colSpan={4} text="Loading tools..." />}
                                            {toolsError && <EmptyRow colSpan={4} text="Unable to load tools." danger />}
                                            {!toolsLoading && !toolsError && tools.length === 0 && <EmptyRow colSpan={4} text="No tools yet." />}
                                            {visibleTools.map((tool) => (
                                                <tr key={tool._id} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                    <td className="px-5 py-4 font-semibold text-white">{tool.name}</td>
                                                    <td className="truncate px-5 py-4 text-white/60">
                                                        {tool.link ? (
                                                            <a className="block truncate transition hover:text-white" href={tool.link} target="_blank" rel="noreferrer">
                                                                {tool.link}
                                                            </a>
                                                        ) : (
                                                            "No link"
                                                        )}
                                                    </td>
                                                    <td className="truncate px-5 py-4 text-white/55">
                                                        {tool.branches?.length ? tool.branches.join(", ") : "All branches"}
                                                    </td>
                                                    <td className="px-5 py-4">
                                                        <RowActions
                                                            label={tool.name}
                                                            onEdit={() => openEditToolModal(tool)}
                                                            onArchive={() =>
                                                                openDeletePrompt({
                                                                    label: tool.name,
                                                                    type: "Tools",
                                                                    onConfirm: () => archiveToolMutation.mutate(tool._id),
                                                                })
                                                            }
                                                        />
                                                    </td>
                                                </tr>
                                            ))}
                                        </>
                                    ) : activeTab === "Product Categories" ? (
                                        <>
                                            {productCategoriesLoading && <EmptyRow colSpan={3} text="Loading categories..." />}
                                            {productCategoriesError && <EmptyRow colSpan={3} text="Unable to load categories." danger />}
                                            {!productCategoriesLoading && !productCategoriesError && productCategories.length === 0 && <EmptyRow colSpan={3} text="No categories yet." />}
                                            {visibleProductCategories.map((category) => (
                                                <tr key={category._id} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                    <td className="px-5 py-4 font-semibold text-white">{category.name}</td>
                                                    <td className="truncate px-5 py-4 text-white/55">{category.description || "No description"}</td>
                                                    <td className="px-5 py-4">
                                                        <RowActions
                                                            label={category.name}
                                                            onEdit={() => openEditProductCategoryModal(category)}
                                                            onArchive={() =>
                                                                openDeletePrompt({
                                                                    label: category.name,
                                                                    type: "Product Categories",
                                                                    onConfirm: () => archiveProductCategoryMutation.mutate(category._id),
                                                                })
                                                            }
                                                        />
                                                    </td>
                                                </tr>
                                            ))}
                                        </>
                                    ) : activeTab === "Features" ? (
                                        <>
                                            {featuresLoading && <EmptyRow colSpan={4} text="Loading features..." />}
                                            {featuresError && <EmptyRow colSpan={4} text="Unable to load features." danger />}
                                            {!featuresLoading && !featuresError && features.length === 0 && <EmptyRow colSpan={4} text="No features yet." />}
                                            {visibleFeatures.map((feature) => (
                                                <tr key={feature.key} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                    <td className="px-5 py-4 font-semibold text-white">{feature.label}</td>
                                                    <td className="truncate px-5 py-4 text-white/55">{feature.description || "No description"}</td>
                                                    <td className="px-5 py-4 text-center">
                                                        <FeatureToggle
                                                            checked={feature.adminEnabled}
                                                            label={`Toggle admin ${feature.label}`}
                                                            onChange={() =>
                                                                updateFeatureMutation.mutate({
                                                                    feature: { ...feature, adminEnabled: !feature.adminEnabled },
                                                                })
                                                            }
                                                        />
                                                    </td>
                                                    <td className="px-5 py-4 text-center">
                                                        <FeatureToggle
                                                            checked={feature.employeeEnabled}
                                                            label={`Toggle employee ${feature.label}`}
                                                            onChange={() =>
                                                                updateFeatureMutation.mutate({
                                                                    feature: { ...feature, employeeEnabled: !feature.employeeEnabled },
                                                                })
                                                            }
                                                        />
                                                    </td>
                                                </tr>
                                            ))}
                                        </>
                                    ) : activeTab === "Themes" ? (
                                        <>
                                            {systemSettingsLoading && <EmptyRow colSpan={4} text="Loading themes..." />}
                                            {systemSettingsError && <EmptyRow colSpan={4} text="Unable to load themes." danger />}
                                            {!systemSettingsLoading &&
                                                !systemSettingsError &&
                                                visibleThemes.map((theme) => {
                                                    const isActive = (systemSettings?.themeKey || "theme-1") === theme.key;
                                                    const isLightTheme = theme.key.startsWith("light-");

                                                    return (
                                                        <tr key={theme.key} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                            <td className="px-5 py-4">
                                                                <div className="font-semibold text-white">{theme.name}</div>
                                                                <div className="mt-1 text-xs text-white/40">{theme.description}</div>
                                                            </td>
                                                            <td className="px-5 py-4 text-white/60">{isLightTheme ? "White" : "Dark"}</td>
                                                            <td className="px-5 py-4">
                                                                <div className="flex items-center gap-1.5">
                                                                    {[theme.colors.primary, theme.colors.secondary, theme.colors.app, theme.colors.panel].map((color) => (
                                                                        <span
                                                                            key={color}
                                                                            className="size-5 rounded-md border border-white/10"
                                                                            style={{ backgroundColor: color }}
                                                                        />
                                                                    ))}
                                                                </div>
                                                            </td>
                                                            <td className="px-5 py-4">
                                                                <button
                                                                    className={[
                                                                        "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
                                                                        isActive
                                                                            ? "theme-primary-border theme-primary-soft-bg text-white"
                                                                            : "border-white/10 bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white",
                                                                    ].join(" ")}
                                                                    type="button"
                                                                    disabled={isActive || updateSystemSettingsMutation.isPending}
                                                                    onClick={() => updateSystemSettingsMutation.mutate({ themeKey: theme.key as ThemeKey })}
                                                                >
                                                                    {isActive && <FiCheck className="size-4" aria-hidden="true" />}
                                                                    {isActive ? "Employee default" : "Set employee default"}
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                        </>
                                    ) : (
                                        <>
                                            {systemSettingsLoading && <EmptyRow colSpan={4} text="Loading system settings..." />}
                                            {systemSettingsError && <EmptyRow colSpan={4} text="Unable to load system settings." danger />}
                                            {!systemSettingsLoading &&
                                                !systemSettingsError &&
                                                currencyOptions.map((currency) => {
                                                    const isActive = (systemSettings?.currencyCode || "USD") === currency.code;

                                                    return (
                                                        <tr key={currency.code} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                            <td className="px-5 py-4 font-semibold text-white">{currency.label}</td>
                                                            <td className="px-5 py-4 text-white/60">{currency.code}</td>
                                                            <td className="px-5 py-4 text-xl font-semibold text-white">{currency.symbol}</td>
                                                            <td className="px-5 py-4">
                                                                <button
                                                                    className={[
                                                                        "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
                                                                        isActive
                                                                            ? "theme-primary-border theme-primary-soft-bg text-white"
                                                                            : "border-white/10 bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white",
                                                                    ].join(" ")}
                                                                    type="button"
                                                                    disabled={isActive || updateSystemSettingsMutation.isPending}
                                                                    onClick={() => updateSystemSettingsMutation.mutate({ currencyCode: currency.code as CurrencyCode })}
                                                                >
                                                                    {isActive && <FiCheck className="size-4" aria-hidden="true" />}
                                                                    {isActive ? "Active currency" : "Use currency"}
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            {!systemSettingsLoading && !systemSettingsError && (
                                                <>
                                                    <tr className="bg-white/[0.02] text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Auto assign leads</td>
                                                        <td className="px-5 py-4 text-white/65">
                                                            {systemSettings?.autoAssignLeadsEnabled === false ? "Off" : "On"}
                                                        </td>
                                                        <td className="px-5 py-4 text-white/45">Leads</td>
                                                        <td className="px-5 py-4">
                                                            <FeatureToggle
                                                                checked={systemSettings?.autoAssignLeadsEnabled !== false}
                                                                label="Toggle lead auto assignment"
                                                                onChange={() =>
                                                                    updateSystemSettingsMutation.mutate({
                                                                        autoAssignLeadsEnabled: !(systemSettings?.autoAssignLeadsEnabled !== false),
                                                                    })
                                                                }
                                                            />
                                                        </td>
                                                    </tr>
                                                    <tr className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Lead mini tabs</td>
                                                        <td className="px-5 py-4 text-white/65">
                                                            {systemSettings?.adminLeadMiniTabsEnabled === false ? "Off" : "On"}
                                                        </td>
                                                        <td className="px-5 py-4 text-white/45">Admin leads</td>
                                                        <td className="px-5 py-4">
                                                            <FeatureToggle
                                                                checked={systemSettings?.adminLeadMiniTabsEnabled !== false}
                                                                label="Toggle admin lead mini tabs"
                                                                onChange={() =>
                                                                    updateSystemSettingsMutation.mutate({
                                                                        adminLeadMiniTabsEnabled: !(systemSettings?.adminLeadMiniTabsEnabled !== false),
                                                                    })
                                                                }
                                                            />
                                                        </td>
                                                    </tr>
                                                    <tr className="bg-white/[0.02] text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Employee lead mini tabs</td>
                                                        <td className="px-5 py-4 text-white/65">
                                                            {systemSettings?.employeeLeadMiniTabsEnabled === false ? "Off" : "On"}
                                                        </td>
                                                        <td className="px-5 py-4 text-white/45">Employee leads</td>
                                                        <td className="px-5 py-4">
                                                            <FeatureToggle
                                                                checked={systemSettings?.employeeLeadMiniTabsEnabled !== false}
                                                                label="Toggle employee lead mini tabs"
                                                                onChange={() =>
                                                                    updateSystemSettingsMutation.mutate({
                                                                        employeeLeadMiniTabsEnabled: !(systemSettings?.employeeLeadMiniTabsEnabled !== false),
                                                                    })
                                                                }
                                                            />
                                                        </td>
                                                    </tr>
                                                    <tr className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Tracker clear data</td>
                                                        <td className="px-5 py-4 text-white/65">
                                                            {systemSettings?.trackerClearDataEnabled === false ? "Disabled" : "Enabled"}
                                                        </td>
                                                        <td className="px-5 py-4 text-white/45">Tracker</td>
                                                        <td className="px-5 py-4">
                                                            <FeatureToggle
                                                                checked={systemSettings?.trackerClearDataEnabled !== false}
                                                                label="Toggle tracker clear data"
                                                                onChange={() =>
                                                                    updateSystemSettingsMutation.mutate({
                                                                        trackerClearDataEnabled: !(systemSettings?.trackerClearDataEnabled !== false),
                                                                    })
                                                                }
                                                            />
                                                        </td>
                                                    </tr>
                                                    <tr className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Payroll billing cycle</td>
                                                        <td className="px-5 py-4 text-white/65">{systemSettings?.payrollBillingCycle || "Semi-monthly"}</td>
                                                        <td className="px-5 py-4 text-white/45">Payroll</td>
                                                        <td className="px-5 py-4">
                                                            <select
                                                                className="h-9 min-w-40 rounded-lg border border-white/10 bg-[var(--surface-bg)] px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                value={systemSettings?.payrollBillingCycle || "Semi-monthly"}
                                                                disabled={updateSystemSettingsMutation.isPending}
                                                                onChange={(event) =>
                                                                    updateSystemSettingsMutation.mutate({
                                                                        payrollBillingCycle: event.target.value as PayrollBillingCycle,
                                                                    })
                                                                }
                                                            >
                                                                {payrollBillingCycleOptions.map((cycle) => (
                                                                    <option key={cycle}>{cycle}</option>
                                                                ))}
                                                            </select>
                                                        </td>
                                                    </tr>
                                                    <tr className="bg-white/[0.02] text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Payroll cut off ranges</td>
                                                        <td className="px-5 py-4 text-white/65">
                                                            <div className="flex flex-wrap gap-2">
                                                                <span className="rounded-md border border-white/10 bg-white/[0.045] px-2.5 py-1 text-xs font-semibold text-white/75">
                                                                    1st: {firstCutoffStartDay}-{firstCutoffEndDay}, paid {firstCutoffPayDay}
                                                                </span>
                                                                <span className="rounded-md border border-white/10 bg-white/[0.045] px-2.5 py-1 text-xs font-semibold text-white/75">
                                                                    2nd: {secondCutoffStartDay}-{secondCutoffEndDay}, paid {secondCutoffPayDay}
                                                                </span>
                                                            </div>
                                                        </td>
                                                        <td className="px-5 py-4 text-white/45">Payroll</td>
                                                        <td className="px-5 py-4">
                                                            <div className="grid min-w-[28rem] gap-3 2xl:grid-cols-2">
                                                                <div className="rounded-lg border border-white/10 bg-black/10 p-3">
                                                                    <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-white/40">1st Cutoff</p>
                                                                    <div className="grid grid-cols-[minmax(4rem,1fr)_auto_minmax(4rem,1fr)_auto_minmax(4rem,1fr)] items-center gap-2">
                                                                        <input
                                                                            className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                            type="number"
                                                                            min={1}
                                                                            max={31}
                                                                            defaultValue={firstCutoffStartDay}
                                                                            disabled={updateSystemSettingsMutation.isPending}
                                                                            onBlur={(event) =>
                                                                                updateSystemSettingsMutation.mutate({
                                                                                    payrollFirstCutoffStartDay: Number(event.target.value),
                                                                                })
                                                                            }
                                                                        />
                                                                        <span className="px-1 text-sm font-semibold text-white/45">to</span>
                                                                        <input
                                                                            className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                            type="number"
                                                                            min={1}
                                                                            max={31}
                                                                            defaultValue={firstCutoffEndDay}
                                                                            disabled={updateSystemSettingsMutation.isPending}
                                                                            onBlur={(event) =>
                                                                                updateSystemSettingsMutation.mutate({
                                                                                    payrollFirstCutoffEndDay: Number(event.target.value),
                                                                                })
                                                                            }
                                                                        />
                                                                        <span className="px-1 text-sm font-semibold text-white/45">paid</span>
                                                                        <input
                                                                            className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                            type="number"
                                                                            min={1}
                                                                            max={31}
                                                                            defaultValue={firstCutoffPayDay}
                                                                            disabled={updateSystemSettingsMutation.isPending}
                                                                            onBlur={(event) =>
                                                                                updateSystemSettingsMutation.mutate({
                                                                                    payrollFirstCutoffPayDay: Number(event.target.value),
                                                                                })
                                                                            }
                                                                        />
                                                                    </div>
                                                                </div>
                                                                <div className="rounded-lg border border-white/10 bg-black/10 p-3">
                                                                    <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-white/40">2nd Cutoff</p>
                                                                    <div className="grid grid-cols-[minmax(4rem,1fr)_auto_minmax(4rem,1fr)_auto_minmax(4rem,1fr)] items-center gap-2">
                                                                        <input
                                                                            className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                            type="number"
                                                                            min={1}
                                                                            max={31}
                                                                            defaultValue={secondCutoffStartDay}
                                                                            disabled={updateSystemSettingsMutation.isPending}
                                                                            onBlur={(event) =>
                                                                                updateSystemSettingsMutation.mutate({
                                                                                    payrollSecondCutoffStartDay: Number(event.target.value),
                                                                                })
                                                                            }
                                                                        />
                                                                        <span className="px-1 text-sm font-semibold text-white/45">to</span>
                                                                        <input
                                                                            className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                            type="number"
                                                                            min={1}
                                                                            max={31}
                                                                            defaultValue={secondCutoffEndDay}
                                                                            disabled={updateSystemSettingsMutation.isPending}
                                                                            onBlur={(event) =>
                                                                                updateSystemSettingsMutation.mutate({
                                                                                    payrollSecondCutoffEndDay: Number(event.target.value),
                                                                                })
                                                                            }
                                                                        />
                                                                        <span className="px-1 text-sm font-semibold text-white/45">paid</span>
                                                                        <input
                                                                            className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                            type="number"
                                                                            min={1}
                                                                            max={31}
                                                                            defaultValue={secondCutoffPayDay}
                                                                            disabled={updateSystemSettingsMutation.isPending}
                                                                            onBlur={(event) =>
                                                                                updateSystemSettingsMutation.mutate({
                                                                                    payrollSecondCutoffPayDay: Number(event.target.value),
                                                                                })
                                                                            }
                                                                        />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    <tr className="bg-white/[0.02] text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Official shift time</td>
                                                        <td className="px-5 py-4 text-white/65">{systemSettings?.officialShiftStartTime || "23:00"} - {systemSettings?.officialShiftEndTime || "08:00"}</td>
                                                        <td className="px-5 py-4 text-white/45">Attendance</td>
                                                        <td className="px-5 py-4">
                                                            <div className="flex flex-wrap gap-2">
                                                                <input
                                                                    className="h-9 w-32 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                    type="time"
                                                                    defaultValue={systemSettings?.officialShiftStartTime || "23:00"}
                                                                    disabled={updateSystemSettingsMutation.isPending}
                                                                    onBlur={(event) =>
                                                                        updateSystemSettingsMutation.mutate({
                                                                            officialShiftStartTime: event.target.value,
                                                                        })
                                                                    }
                                                                />
                                                                <input
                                                                    className="h-9 w-32 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                    type="time"
                                                                    defaultValue={systemSettings?.officialShiftEndTime || "08:00"}
                                                                    disabled={updateSystemSettingsMutation.isPending}
                                                                    onBlur={(event) =>
                                                                        updateSystemSettingsMutation.mutate({
                                                                            officialShiftEndTime: event.target.value,
                                                                        })
                                                                    }
                                                                />
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    <tr className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Attendance time zone</td>
                                                        <td className="px-5 py-4 text-white/65">{systemSettings?.attendanceTimeZone || "Asia/Manila"}</td>
                                                        <td className="px-5 py-4 text-white/45">Attendance</td>
                                                        <td className="px-5 py-4">
                                                            <select
                                                                className="h-9 min-w-64 rounded-lg border border-white/10 bg-[var(--surface-bg)] px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                value={systemSettings?.attendanceTimeZone || "Asia/Manila"}
                                                                disabled={updateSystemSettingsMutation.isPending}
                                                                onChange={(event) =>
                                                                    updateSystemSettingsMutation.mutate({
                                                                        attendanceTimeZone: event.target.value,
                                                                    })
                                                                }
                                                            >
                                                                {attendanceTimeZoneOptions.map((timeZone) => (
                                                                    <option key={timeZone.value} value={timeZone.value}>{timeZone.label}</option>
                                                                ))}
                                                            </select>
                                                        </td>
                                                    </tr>
                                                    {attendanceDurationModelEnabled && <tr className="text-sm text-white/80">
                                                        <td className="px-5 py-4 font-semibold text-white">Attendance allowances and cutoff</td>
                                                        <td colSpan={3} className="px-5 py-4"><AttendancePolicyEditor /></td>
                                                    </tr>}
                                                    {!attendanceDurationModelEnabled && <>
                                                    <tr className="bg-white/[0.02] text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Official 1st break</td>
                                                        <td className="px-5 py-4 text-white/65">{systemSettings?.officialFirstBreakStartTime || "01:00"} - {systemSettings?.officialFirstBreakEndTime || "01:15"}</td>
                                                        <td className="px-5 py-4 text-white/45">Attendance</td>
                                                        <td className="px-5 py-4">
                                                            <div className="flex flex-wrap gap-2">
                                                                <input
                                                                    className="h-9 w-32 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                    type="time"
                                                                    defaultValue={systemSettings?.officialFirstBreakStartTime || "01:00"}
                                                                    disabled={updateSystemSettingsMutation.isPending}
                                                                    onBlur={(event) =>
                                                                        updateSystemSettingsMutation.mutate({
                                                                            officialFirstBreakStartTime: event.target.value,
                                                                        })
                                                                    }
                                                                />
                                                                <input
                                                                    className="h-9 w-32 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                    type="time"
                                                                    defaultValue={systemSettings?.officialFirstBreakEndTime || "01:15"}
                                                                    disabled={updateSystemSettingsMutation.isPending}
                                                                    onBlur={(event) =>
                                                                        updateSystemSettingsMutation.mutate({
                                                                            officialFirstBreakEndTime: event.target.value,
                                                                        })
                                                                    }
                                                                />
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    <tr className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Official lunch break</td>
                                                        <td className="px-5 py-4 text-white/65">{systemSettings?.officialLunchBreakStartTime || "03:15"} - {systemSettings?.officialLunchBreakEndTime || "04:15"}</td>
                                                        <td className="px-5 py-4 text-white/45">Attendance</td>
                                                        <td className="px-5 py-4">
                                                            <div className="flex flex-wrap gap-2">
                                                                <input
                                                                    className="h-9 w-32 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                    type="time"
                                                                    defaultValue={systemSettings?.officialLunchBreakStartTime || "03:15"}
                                                                    disabled={updateSystemSettingsMutation.isPending}
                                                                    onBlur={(event) =>
                                                                        updateSystemSettingsMutation.mutate({
                                                                            officialLunchBreakStartTime: event.target.value,
                                                                        })
                                                                    }
                                                                />
                                                                <input
                                                                    className="h-9 w-32 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                    type="time"
                                                                    defaultValue={systemSettings?.officialLunchBreakEndTime || "04:15"}
                                                                    disabled={updateSystemSettingsMutation.isPending}
                                                                    onBlur={(event) =>
                                                                        updateSystemSettingsMutation.mutate({
                                                                            officialLunchBreakEndTime: event.target.value,
                                                                        })
                                                                    }
                                                                />
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    <tr className="bg-white/[0.02] text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Official 2nd break</td>
                                                        <td className="px-5 py-4 text-white/65">{systemSettings?.officialSecondBreakStartTime || "06:15"} - {systemSettings?.officialSecondBreakEndTime || "06:30"}</td>
                                                        <td className="px-5 py-4 text-white/45">Attendance</td>
                                                        <td className="px-5 py-4">
                                                            <div className="flex flex-wrap gap-2">
                                                                <input
                                                                    className="h-9 w-32 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                    type="time"
                                                                    defaultValue={systemSettings?.officialSecondBreakStartTime || "06:15"}
                                                                    disabled={updateSystemSettingsMutation.isPending}
                                                                    onBlur={(event) =>
                                                                        updateSystemSettingsMutation.mutate({
                                                                            officialSecondBreakStartTime: event.target.value,
                                                                        })
                                                                    }
                                                                />
                                                                <input
                                                                    className="h-9 w-32 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                    type="time"
                                                                    defaultValue={systemSettings?.officialSecondBreakEndTime || "06:30"}
                                                                    disabled={updateSystemSettingsMutation.isPending}
                                                                    onBlur={(event) =>
                                                                        updateSystemSettingsMutation.mutate({
                                                                            officialSecondBreakEndTime: event.target.value,
                                                                        })
                                                                    }
                                                                />
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    </>}
                                                    <tr className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Late grace minutes</td>
                                                        <td className="px-5 py-4 text-white/65">{systemSettings?.lateGraceMinutes ?? 0} min</td>
                                                        <td className="px-5 py-4 text-white/45">Attendance</td>
                                                        <td className="px-5 py-4">
                                                            <input
                                                                className="h-9 w-28 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)] disabled:opacity-60"
                                                                type="number"
                                                                min={0}
                                                                max={240}
                                                                defaultValue={systemSettings?.lateGraceMinutes ?? 0}
                                                                disabled={updateSystemSettingsMutation.isPending}
                                                                onBlur={(event) =>
                                                                    updateSystemSettingsMutation.mutate({
                                                                        lateGraceMinutes: Number(event.target.value),
                                                                    })
                                                                }
                                                            />
                                                        </td>
                                                    </tr>
                                                    <tr className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                        <td className="px-5 py-4 font-semibold text-white">Employee deductions</td>
                                                        <td className="px-5 py-4 text-white/65">Payroll Deductions tab</td>
                                                        <td className="px-5 py-4 text-white/45">Payroll</td>
                                                        <td className="px-5 py-4 text-sm text-white/45">
                                                            Add SSS, benefits, or other fixed employee deductions in Payroll &gt; Deductions.
                                                        </td>
                                                    </tr>
                                                </>
                                            )}
                                        </>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        {activeTab === "System" ? (
                            <div className="flex min-h-14 items-center justify-between border-t border-white/10 px-5 py-3">
                                <p className="text-xs text-white/45">
                                    Showing {systemSettingCount} system setting{systemSettingCount === 1 ? "" : "s"}
                                </p>
                                <span className="rounded-md border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-semibold text-white/55">
                                    {activeTab}
                                </span>
                            </div>
                        ) : (
                            <DataTablePagination
                                totalItems={activeTotalItems}
                                page={page}
                                pageSize={pageSize}
                                onPageChange={setPage}
                                onPageSizeChange={(nextPageSize) => {
                                    setPageSize(nextPageSize);
                                    setPage(1);
                                }}
                            />
                        )}
                    </div>
                </div>
            </section>

            {isBusinessModalOpen && (
                <SettingsModal
                    title="Add Business"
                    subtitle="New businesses get their own MongoDB database automatically."
                    onClose={closeBusinessModal}
                    onSubmit={handleCreateBusiness}
                >
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Business Name</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={businessForm.name}
                            onChange={(event) => setBusinessForm({ name: event.target.value })}
                            placeholder="Business C"
                            autoFocus
                        />
                    </label>
                </SettingsModal>
            )}

            {isRoleModalOpen && (
                <SettingsModal
                    title={editingRoleId ? "Edit Department Role" : "Add Department Role"}
                    subtitle="Department roles appear in the employee form."
                    onClose={closeRoleModal}
                    onSubmit={handleSaveRole}
                >
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Department</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={roleForm.department}
                            onChange={(event) => setRoleForm((role) => ({ ...role, department: event.target.value }))}
                            placeholder="Sales"
                        />
                    </label>
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Role</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={roleForm.name}
                            onChange={(event) => setRoleForm((role) => ({ ...role, name: event.target.value }))}
                            placeholder="Sales Agent"
                        />
                    </label>
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Branch Category</span>
                        <select
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={roleForm.branch}
                            onChange={(event) => setRoleForm((role) => ({ ...role, branch: event.target.value }))}
                        >
                            <option>All branches</option>
                            {branches.map((branch) => (
                                <option key={branch._id}>{branch.name}</option>
                            ))}
                        </select>
                    </label>
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Description</span>
                        <textarea
                            className="mt-2 min-h-24 w-full resize-none rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={roleForm.description}
                            onChange={(event) => setRoleForm((role) => ({ ...role, description: event.target.value }))}
                            placeholder="Responsibilities, coverage, or internal notes"
                        />
                    </label>
                </SettingsModal>
            )}

            {isBranchModalOpen && (
                <SettingsModal
                    title={editingBranchId ? "Edit Branch" : "Add Branch"}
                    subtitle="Branches appear in credentials and branch filters."
                    onClose={closeBranchModal}
                    onSubmit={handleSaveBranch}
                >
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Branch Name</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={branchForm.name}
                            onChange={(event) => setBranchForm((branch) => ({ ...branch, name: event.target.value }))}
                            placeholder="Assistly HQ"
                        />
                    </label>
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Company</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={branchForm.company}
                            onChange={(event) => setBranchForm((branch) => ({ ...branch, company: event.target.value }))}
                            placeholder="Assistly"
                        />
                    </label>
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Location</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={branchForm.location}
                            onChange={(event) => setBranchForm((branch) => ({ ...branch, location: event.target.value }))}
                            placeholder="Main office, Finance team, Austin..."
                        />
                    </label>
                </SettingsModal>
            )}

            {isToolModalOpen && (
                <SettingsModal
                    title={editingToolId ? "Edit Tool" : "Add Tool"}
                    subtitle="Tools can be referenced by credentials and team workflows."
                    onClose={closeToolModal}
                    onSubmit={handleSaveTool}
                >
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Tool Name</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={toolForm.name}
                            onChange={(event) => setToolForm((tool) => ({ ...tool, name: event.target.value }))}
                            placeholder="Google Workspace"
                        />
                    </label>
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Link</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={toolForm.link}
                            onChange={(event) => setToolForm((tool) => ({ ...tool, link: event.target.value }))}
                            placeholder="https://example.com"
                        />
                    </label>
                    <div className="relative">
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Branches</span>
                        <button
                            className={[
                                "mt-2 flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border bg-black/20 px-3 text-left text-sm font-semibold transition",
                                isToolBranchDropdownOpen
                                    ? "border-[#842cff] text-white ring-2 ring-[#842cff]/20"
                                    : "border-white/10 text-white/70 hover:bg-white/[0.04] hover:text-white",
                            ].join(" ")}
                            type="button"
                            onClick={() => setIsToolBranchDropdownOpen((isOpen) => !isOpen)}
                            aria-expanded={isToolBranchDropdownOpen}
                        >
                            <span className="min-w-0 truncate">
                                {toolForm.branches.length ? toolForm.branches.join(", ") : "Select branches"}
                            </span>
                            <FiChevronDown
                                className={[
                                    "size-4 shrink-0 text-white/40 transition",
                                    isToolBranchDropdownOpen ? "rotate-180" : "",
                                ].join(" ")}
                                aria-hidden="true"
                            />
                        </button>
                        {isToolBranchDropdownOpen && (
                            <div className="absolute left-0 right-0 top-[4.7rem] z-40 max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-[#0d1018] py-1 shadow-2xl shadow-black/40">
                                {branches.map((branch) => {
                                    const isSelected = toolForm.branches.includes(branch.name);

                                    return (
                                        <button
                                            key={branch._id}
                                            className={[
                                                "flex h-10 w-full items-center justify-between gap-3 px-3 text-left text-sm font-semibold transition",
                                                isSelected
                                                    ? "bg-[#842cff]/20 text-white"
                                                    : "text-white/65 hover:bg-white/[0.06] hover:text-white",
                                            ].join(" ")}
                                            type="button"
                                            onClick={() =>
                                                setToolForm((tool) => ({
                                                    ...tool,
                                                    branches: isSelected
                                                        ? tool.branches.filter((branchName) => branchName !== branch.name)
                                                        : [...tool.branches, branch.name],
                                                }))
                                            }
                                        >
                                            <span className="truncate">{branch.name}</span>
                                            {isSelected && <FiCheck className="size-4 text-[#9df6b7]" aria-hidden="true" />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </SettingsModal>
            )}

            {isProductCategoryModalOpen && (
                <SettingsModal
                    title={editingProductCategoryId ? "Edit Category" : "Add Category"}
                    subtitle="Categories appear below the title field for product entries."
                    onClose={closeProductCategoryModal}
                    onSubmit={handleSaveProductCategory}
                >
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Category Name</span>
                        <input
                            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={productCategoryForm.name}
                            onChange={(event) => setProductCategoryForm((category) => ({ ...category, name: event.target.value }))}
                            placeholder="Website package"
                        />
                    </label>
                    <label>
                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Description</span>
                        <textarea
                            className="mt-2 min-h-24 w-full resize-none rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                            value={productCategoryForm.description}
                            onChange={(event) => setProductCategoryForm((category) => ({ ...category, description: event.target.value }))}
                            placeholder="Optional category description"
                        />
                    </label>
                </SettingsModal>
            )}

            {deleteTarget && (
                <TwoStepDeleteModal
                    title="Are you sure?"
                    label={deleteTarget.label}
                    context={deleteTarget.type}
                    onCancel={closeDeletePrompt}
                    onConfirm={confirmDelete}
                />
            )}
        </AdminLayout>
    );
}

function EmptyRow({ colSpan, text, danger = false }: { colSpan: number; text: string; danger?: boolean }) {
    return (
        <tr>
            <td className={`px-5 py-8 text-center text-sm ${danger ? "text-red-200" : "text-white/45"}`} colSpan={colSpan}>
                {text}
            </td>
        </tr>
    );
}

function RowActions({ label, onEdit, onArchive }: { label: string; onEdit: () => void; onArchive: () => void }) {
    return (
        <div className="flex justify-end gap-1.5">
            <button
                className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white !text-black transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                type="button"
                aria-label={`Edit ${label}`}
                onClick={onEdit}
            >
                <FiEdit2 className="size-4" aria-hidden="true" />
            </button>
            <button
                className="flex size-8 items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 transition hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-400/35"
                type="button"
                aria-label={`Archive ${label}`}
                onClick={onArchive}
            >
                <FiArchive className="size-4" aria-hidden="true" />
            </button>
        </div>
    );
}

function FeatureToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
    return (
        <button
            className={[
                "mx-auto flex h-7 w-12 items-center rounded-full border px-1 transition focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_60%,transparent)]",
                checked ? "theme-primary-border bg-[color-mix(in_srgb,var(--primary)_45%,transparent)]" : "border-white/10 bg-white/[0.06]",
            ].join(" ")}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={onChange}
        >
            <span
                className={[
                    "size-5 rounded-full bg-white shadow transition",
                    checked ? "translate-x-5" : "translate-x-0",
                ].join(" ")}
            />
        </button>
    );
}

function SettingsModal({
    title,
    subtitle,
    onClose,
    onSubmit,
    children,
}: {
    title: string;
    subtitle: string;
    onClose: () => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    children: React.ReactNode;
}) {
    return (
        <div
            className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <form
                className="modal-panel-enter flex w-full max-w-[30rem] flex-col rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40"
                onSubmit={onSubmit}
            >
                <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                    <div>
                        <h3 className="text-base font-semibold text-white">{title}</h3>
                        <p className="mt-1 text-sm text-white/45">{subtitle}</p>
                    </div>
                    <button
                        className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                        type="button"
                        aria-label="Close settings modal"
                        onClick={onClose}
                    >
                        <FiX className="size-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="grid gap-4 p-5">{children}</div>

                <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-3.5">
                    <button
                        className="h-10 rounded-lg border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                        type="button"
                        onClick={onClose}
                    >
                        Cancel
                    </button>
                    <button
                        className="flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                        type="submit"
                    >
                        <FiSave className="size-4" aria-hidden="true" />
                        Save
                    </button>
                </div>
            </form>
        </div>
    );
}

function TwoStepDeleteModal({
    title,
    label,
    context,
    onCancel,
    onConfirm,
}: {
    title: string;
    label: string;
    context: string;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div
            className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onCancel();
                }
            }}
        >
            <div className="modal-panel-enter w-full max-w-[32rem] overflow-hidden rounded-lg border border-red-400/20 bg-[#0d1018] shadow-2xl shadow-red-950/30">
                <div className="bg-[radial-gradient(circle_at_15%_20%,rgba(239,68,68,0.22),transparent_35%),linear-gradient(135deg,rgba(239,68,68,0.12),rgba(132,44,255,0.08))] px-5 py-4">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-red-300/20 bg-red-500/15 text-red-100">
                                <FiAlertTriangle className="size-5" aria-hidden="true" />
                            </span>
                            <div>
                                <p className="text-xs font-medium uppercase tracking-[0.14em] text-red-100/55">Delete {context}</p>
                                <h3 className="mt-1 text-lg font-semibold text-white">{title}</h3>
                                <p className="mt-1 text-sm text-red-50/60">This will remove it from active records.</p>
                            </div>
                        </div>
                        <button className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={onCancel} aria-label="Close delete confirmation">
                            <FiX className="size-4" aria-hidden="true" />
                        </button>
                    </div>
                </div>
                <div className="p-5">
                    <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Selected Record</p>
                        <p className="mt-2 text-sm font-semibold text-white">{label}</p>
                    </div>
                    <div className="mt-3 rounded-lg border border-yellow-300/20 bg-yellow-300/10 p-3">
                        <p className="text-sm leading-6 text-yellow-50/75">
                            Are you sure you want to delete {label}?
                        </p>
                    </div>
                </div>
                <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                    <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={onCancel}>Cancel</button>
                    <button className="h-10 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition hover:bg-red-400" type="button" onClick={onConfirm}>Delete</button>
                </div>
            </div>
        </div>
    );
}

const EMPTY_QUERY_ROWS: [] = [];
