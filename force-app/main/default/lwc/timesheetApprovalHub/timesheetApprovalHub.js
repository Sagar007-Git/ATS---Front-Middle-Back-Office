import { LightningElement, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';

import getPendingApprovals from '@salesforce/apex/ManagerApprovalController.getPendingApprovals';
import processTimesheets from '@salesforce/apex/ManagerApprovalController.processTimesheets';
import processTimesheetsByIds from '@salesforce/apex/ManagerApprovalController.processTimesheetsByIds';
import processExpenses from '@salesforce/apex/ManagerApprovalController.processExpenses';
import getActiveTasks from '@salesforce/apex/ManagerApprovalController.getActiveTasks';
import getManagerContext from '@salesforce/apex/ManagerApprovalController.getManagerContext';

import getApprovalsByStatus from '@salesforce/apex/ManagerApprovalController.getApprovalsByStatus';
import getExpensesByStatus from '@salesforce/apex/ManagerApprovalController.getExpensesByStatus';
import { NavigationMixin } from 'lightning/navigation';

export default class TimesheetApprovalHub extends NavigationMixin(LightningElement) {
    @track projectData = [];
    @track isLoading = true;
    wiredApprovalResults;

    // Global & UI State
    @track managerInfo = { name: 'Loading...', role: '...', initials: '' };
    @track selectedProjectId = '';
    @track searchQuery = '';

    // Modals
    @track isRejectModalOpen = false;
    @track taskOptions = [];
    @track isDocumentPreviewModalOpen = false;
    @track previewDocument = {};

    // Rejection State
    @track rejectReason = '';
    @track rejectTargetType = 'timesheet';
    activeRejectProjectId;
    activeRejectCandidateId;

    // ==========================================
    // 🗂️ TAB MANAGEMENT & EXPENSE STATE
    // ==========================================
    @track activeTab = 'timesheets'; // 'timesheets' or 'expenses'
    @track statusFilter = 'All'; // 'All', 'Submitted', 'Approved', 'Rejected'

    get isTimesheetTab() { return this.activeTab === 'timesheets'; }
    get isExpenseTab() { return this.activeTab === 'expenses'; }

    // ==========================================
    // 🎛️ EXPENSE UI GETTERS
    // ==========================================
    
    // 🌟 THE FIX: Move the "!" logic here
    get isApproveExpenseDisabled() {
        return !this.hasActiveExpenseCandidates;
    }

    // Existing hasActiveExpenseCandidates for reference
    get hasActiveExpenseCandidates() {
        return this.activeExpenseProject && 
               this.activeExpenseProject.candidates && 
               this.activeExpenseProject.candidates.length > 0;
    }

    get hasPendingExpenseCandidates() {
        return this.activeExpenseProject?.candidates?.some(cand => cand.hasPendingExpenses);
    }
    
    get timesheetTabClass() { return this.activeTab === 'timesheets' ? 'saas-tab active' : 'saas-tab'; }
    get expenseTabClass() { return this.activeTab === 'expenses' ? 'saas-tab active' : 'saas-tab'; }
    get statusFilterOptions() {
        return [
            { label: this.isTimesheetTab ? 'All Projects' : 'All Expenses', value: 'All' },
            { label: 'Pending Approval', value: 'Submitted' },
            { label: 'Approved', value: 'Approved' },
            { label: 'Rejected', value: 'Rejected' }
        ];
    }

    // 🌟 EXPENSE FILTER OPTIONS
    get categoryFilterOptions() {
        return [
            { label: 'All Categories', value: 'All' },
            { label: 'Travel', value: 'Travel' },
            { label: 'Meals', value: 'Meals' },
            { label: 'Office Supplies', value: 'Office Supplies' },
            { label: 'Software', value: 'Software' },
            { label: 'Training', value: 'Training' },
            { label: 'Other', value: 'Other' }
        ];
    }
    get isPendingStatus() { return this.statusFilter === 'Submitted'; }
    get isAllStatus() { return this.statusFilter === 'All'; }
    get isApprovedStatus() { return this.statusFilter === 'Approved'; }
    get isRejectedStatus() { return this.statusFilter === 'Rejected'; }

    handleTabSwitch(event) {
        const newTab = event.currentTarget.dataset.tab;
        this.activeTab = newTab;
        this.statusFilter = 'All'; // Reset status filter
        
        // Reset UI state for both tabs
        this.searchQuery = '';
        this.expenseSearchQuery = '';
        this.rejectReason = '';
        this.isRejectModalOpen = false;
        
        // Reset expense filters
        this.categoryFilter = 'All';
        this.dateFromFilter = '';
        this.dateToFilter = '';
        
        // If switching to expenses, auto-select first project and open first expense
        if (newTab === 'expenses' && this.expenseProjectData.length > 0) {
            this.selectedExpenseProjectId = this.expenseProjectData[0].projectId;
            
            // Auto-open first candidate's first expense
            setTimeout(() => {
                if (this.expenseProjectData[0].candidates?.length > 0) {
                    this.expenseProjectData = this.expenseProjectData.map(proj => {
                        if (proj.projectId === this.selectedExpenseProjectId && proj.candidates?.length > 0) {
                            const updatedCandidates = proj.candidates.map((cand, index) => {
                                if (index === 0) {
                                    return { ...cand, isExpanded: true, chevronIcon: 'utility:chevrondown' };
                                }
                                return cand;
                            });
                            return { ...proj, candidates: updatedCandidates };
                        }
                        return proj;
                    });
                }
            }, 100);
        } else if (newTab === 'timesheets') {
            // Reset timesheet selection but keep data loaded
            this.selectedProjectId = ''; // Will auto-select first project when data loads
        }
    }

    handleStatusFilterChange(event) {
        this.statusFilter = event.detail.value;
    }

    // ==========================================
    // 🗂️ EXPENSE STATE & PAGINATION
    // ==========================================
    @track allExpenses = [];         // Holds ALL 1000 records
    @track displayedExpenses = [];   // Holds ONLY the current 20 records
    
    // Pagination limits
    @track currentPage = 1;
    pageSize = 20; 
    @track totalExpensePages = 1;

    get isFirstPage() { return this.currentPage === 1; }
    get isLastPage() { return this.currentPage >= this.totalExpensePages; }

    // 🌟 WIRE THE REAL EXPENSES
    

    // ==========================================
    // 🗂️ EXPENSE STATE & GROUPING LOGIC
    // ==========================================
    @track expenseProjectData = [];
    @track selectedExpenseProjectId = '';
    @track expenseSearchQuery = '';

    // 🌟 EXPENSE FILTERS
    @track categoryFilter = 'All';
    @track dateFromFilter = '';
    @track dateToFilter = '';

    // 🌟 THE NEW WIRE: Groups flat expenses into Projects -> Candidates -> Receipts
    wiredExpensesResult;

    @wire(getExpensesByStatus, { 
        status: '$statusFilter',
        category: '$categoryFilter',
        dateFrom: '$dateFromFilter',
        dateTo: '$dateToFilter'
    })
    wiredExpenses(result) {
        this.wiredExpensesResult = result;
        if (result.data) {
            let projectMap = {};

            result.data.forEach(exp => {
                let pId = exp.Project__c || 'No-Project';
                let pName = exp.Project__r?.Name || 'General Expenses';
                let cId = exp.Contact__c || 'Unknown-Contact';
                let cName = exp.Contact__r?.Name || 'Unknown Resource';

                // 1. Build Project Level
                if (!projectMap[pId]) {
                    projectMap[pId] = {
                        projectId: pId,
                        projectName: pName,
                        totalPendingAmount: 0,
                        expenseCount: 0,
                        candidatesMap: {}
                    };
                }

                // 2. Build Candidate Level
                if (!projectMap[pId].candidatesMap[cId]) {
                    projectMap[pId].candidatesMap[cId] = {
                        candidateId: cId,
                        candidateName: cName,
                        initials: cName !== 'Unknown Resource' ? cName.substring(0, 2).toUpperCase() : 'EX',
                        totalAmount: 0,
                        isExpanded: false,
                        chevronIcon: 'utility:chevronright',
                        expenses: [],
                        statusBadge: null
                    };
                }

                // 3. Process the individual Expense Item & File
                let amount = exp.Amount__c || 0;
                projectMap[pId].totalPendingAmount += amount;
                projectMap[pId].expenseCount += 1;
                projectMap[pId].candidatesMap[cId].totalAmount += amount;

                let hasReceipt = false;
                let receiptName = '';
                let receiptSize = '';
                let documentId = '';
                let contentVersionId = '';

                if (exp.ContentDocumentLinks && exp.ContentDocumentLinks.length > 0) {
                    hasReceipt = true;
                    const doc = exp.ContentDocumentLinks[0].ContentDocument;
                    documentId = doc.Id;
                    contentVersionId = doc.LatestPublishedVersionId;
                    receiptName = doc.Title + '.' + doc.FileExtension;
                    const bytes = doc.ContentSize || 0;
                    receiptSize = bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
                }

                projectMap[pId].candidatesMap[cId].expenses.push({
                    id: exp.Id,
                    amount: amount.toFixed(2),
                    date: exp.Expense_Date__c,
                    category: exp.Category__c || 'Uncategorized',
                    notes: exp.Description__c || '— No notes —',
                    hasReceipt: hasReceipt,
                    receiptName: receiptName,
                    receiptSize: receiptSize,
                    documentId: contentVersionId || documentId, // Use ContentVersionId for download if available
                    status: exp.Status__c || 'Submitted'
                });
            });

            // Convert Maps back to Arrays for LWC tracking
            this.expenseProjectData = Object.values(projectMap).map(p => {
                return {
                    ...p,
                    candidates: Object.values(p.candidatesMap).map(cand => {
                        // Build status badge based on all expenses for this candidate
                        let statuses = new Set(cand.expenses.map(e => e.status));
                        let statusBadge = null;
                        
                        if (statuses.size === 1) {
                            const status = Array.from(statuses)[0];
                            if (status === 'Approved') {
                                statusBadge = { label: 'Approved', className: 'saas-pill pill-success' };
                            } else if (status === 'Rejected') {
                                statusBadge = { label: 'Rejected', className: 'saas-pill pill-danger' };
                            } else if (status === 'Submitted') {
                                statusBadge = { label: 'Pending', className: 'saas-pill pill-warning' };
                            }
                        } else if (statuses.size > 1) {
                            statusBadge = { label: 'Mixed Status', className: 'saas-pill pill-neutral' };
                        }
                        
                        const hasPendingExpenses = cand.expenses.some(e => e.status === 'Submitted');
                        return { 
                            ...cand, 
                            statusBadge, 
                            hasPendingExpenses,
                            totalAmount: parseFloat(cand.totalAmount).toFixed(2) // Format to 2 decimal places
                        };
                    }).sort((a, b) => b.totalAmount - a.totalAmount) // Sort highest spenders to top
                };
            }).sort((a, b) => b.totalPendingAmount - a.totalPendingAmount); // Sort most expensive projects to top

            if (this.expenseProjectData.length > 0 && !this.selectedExpenseProjectId) {
                this.selectedExpenseProjectId = this.expenseProjectData[0].projectId;
                // Auto-open first candidate in first project
                if (this.expenseProjectData[0].candidates?.length > 0) {
                    this.expenseProjectData = this.expenseProjectData.map((proj, projIdx) => {
                        if (projIdx === 0) {
                            return {
                                ...proj,
                                candidates: proj.candidates.map((cand, candIdx) => {
                                    if (candIdx === 0) {
                                        return { ...cand, isExpanded: true, chevronIcon: 'utility:chevrondown' };
                                    }
                                    return cand;
                                })
                            };
                        }
                        return proj;
                    });
                }
            }

            this.allExpenses = result.data || [];
            this.totalExpensePages = Math.max(1, Math.ceil((this.allExpenses?.length || 0) / this.pageSize));
            this.currentPage = 1;
            this.updatePagination();
        }
    }

    // ==========================================
    // 🎛️ EXPENSE UI GETTERS & ACTIONS
    // ==========================================
    get expenseSidebar() {
        return this.expenseProjectData.map(p => {
            return {
                ...p,
                className: p.projectId === this.selectedExpenseProjectId ? 'sidebar-item active' : 'sidebar-item',
                formattedAmount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(p.totalPendingAmount)
            };
        });
    }

    get activeExpenseProject() {
        if (!this.expenseProjectData) return null;
        let project = this.expenseProjectData.find(p => p.projectId === this.selectedExpenseProjectId);
        
        if (project && project.candidates) {
            let filtered = { ...project };
            if (this.expenseSearchQuery) {
                filtered.candidates = project.candidates.filter(cand => 
                    cand.candidateName.toLowerCase().includes(this.expenseSearchQuery)
                );
            }
            return filtered;
        }
        return null;
    }

    get hasActiveExpenseCandidates() {
        return this.activeExpenseProject && this.activeExpenseProject.candidates.length > 0;
    }

    get hasNoExpenseProjects() {
        return !this.expenseProjectData || this.expenseProjectData.length === 0;
    }
 
    get expenseNoResultsMessage() {
        if (this.categoryFilter !== 'All' && this.statusFilter !== 'All') {
            return `${this.statusFilter} expenses are not available for ${this.categoryFilter}`;
        }
        if (this.categoryFilter !== 'All') {
            return `Expense reports for ${this.categoryFilter} are not available.`;
        }
        if (this.statusFilter !== 'All') {
            return `No projects with ${this.statusFilter} expenses.`;
        }
        return 'No expense reports available.';
    }

    handleExpenseProjectSelect(event) {
        this.selectedExpenseProjectId = event.currentTarget.dataset.projectid;
    }

    handleExpenseSearch(event) {
        this.expenseSearchQuery = event.target.value.toLowerCase();
    }

    // 🌟 EXPENSE FILTER HANDLERS
    handleCategoryFilterChange(event) {
        this.categoryFilter = event.detail.value;
    }

    handleDateFromFilterChange(event) {
        this.dateFromFilter = event.target.value;
    }

    handleDateToFilterChange(event) {
        this.dateToFilter = event.target.value;
    }

    handleClearExpenseFilters() {
        this.categoryFilter = 'All';
        this.dateFromFilter = '';
        this.dateToFilter = '';
    }

    // 🌟 RE-INTRODUCED: The Accordion Toggle for Expenses
    toggleExpenseAccordion(event) {
        const candidateId = event.currentTarget.dataset.candidateid;
        
        this.expenseProjectData = this.expenseProjectData.map(proj => {
            if (proj.projectId !== this.selectedExpenseProjectId) return proj; 
            
            const updatedCandidates = proj.candidates?.map(cand => {
                if (cand.candidateId === candidateId) {
                    const nextState = !cand.isExpanded;
                    return { ...cand, isExpanded: nextState, chevronIcon: nextState ? 'utility:chevrondown' : 'utility:chevronright' };
                }
                return cand;
            });
            return { ...proj, candidates: updatedCandidates };
        });
    }

    // 🌟 DOCUMENT PREVIEW IN MODAL - ENHANCED
    // --- 2. Unified Preview Logic (High Speed) ---
    handleViewReceipt(event) {
        event.stopPropagation();
        const docId = event.currentTarget.dataset.id;
        const fileName = event.currentTarget.dataset.name;

        if (!docId) return;

        const extension = fileName.split('.').pop().toLowerCase();
        const baseUrl = communityPath ? communityPath : '';
        
        // Setting the object the HTML is looking for
        this.previewDocument = {
            receiptName: fileName,
            fileUrl: `${baseUrl}/sfc/servlet.shepherd/version/download/${docId}`,
            fileType: extension === 'pdf' ? 'pdf' : (['png', 'jpg', 'jpeg'].includes(extension) ? 'image' : 'other')
        };

        this.isDocumentPreviewModalOpen = true;
    }

    // --- 3. Getters for Modal Templates ---
    get isImageFile() { return this.previewDocument.fileType === 'image'; }
    get isPdfFile() { return this.previewDocument.fileType === 'pdf'; }

    closeDocumentPreview() {
        this.isDocumentPreviewModalOpen = false;
    }

    // 🌟 PAGINATION ENGINE
    updatePagination() {
        const start = (this.currentPage - 1) * this.pageSize;
        const end = start + this.pageSize;
        this.displayedExpenses = this.allExpenses.slice(start, end);
    }

    handleNextPage() {
        if (!this.isLastPage) {
            this.currentPage++;
            this.updatePagination();
        }
    }

    handlePrevPage() {
        if (!this.isFirstPage) {
            this.currentPage--;
            this.updatePagination();
        }
    }

    // ==========================================
    // 📊 DYNAMIC KPIs (Switches based on Tab!)
    // ==========================================
    get kpiIconOne() { return this.isTimesheetTab ? 'standard:drafts' : 'standard:expense_report'; }
    get kpiIconTwo() { return this.isTimesheetTab ? 'standard:operating_hours' : 'standard:currency'; }
    get kpiTitleOne() { 
        if (this.isTimesheetTab) {
            return this.statusFilter === 'Submitted' ? 'PENDING REVIEWS' : 
                   this.statusFilter === 'Approved' ? 'APPROVED ENTRIES' : 
                   this.statusFilter === 'Rejected' ? 'REJECTED ENTRIES' : 'ALL ENTRIES';
        } else {
            return this.statusFilter === 'Submitted' ? 'PENDING EXPENSES' : 
                   this.statusFilter === 'Approved' ? 'APPROVED EXPENSES' : 
                   this.statusFilter === 'Rejected' ? 'REJECTED EXPENSES' : 'ALL EXPENSES';
        }
    }
    get kpiValueOne() { 
        return this.isTimesheetTab ? this.pendingCount : (this.allExpenses ? this.allExpenses.length : 0); 
    }
    get kpiTitleTwo() { return this.isTimesheetTab ? 'TOTAL HOURS' : 'TOTAL AMOUNT'; }
    get kpiValueTwo() { 
        if (this.isTimesheetTab) return this.totalHours;
        
        let total = 0;
        if (this.allExpenses) {
            // ✅ FIX: Use the Salesforce API field name Amount__c
            total = this.allExpenses.reduce((sum, exp) => {
                const val = parseFloat(exp.Amount__c || 0);
                return sum + val;
            }, 0);
        }
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(total);
    }
    get kpiSuffixTwo() { return this.isTimesheetTab ? 'hrs' : 'USD'; }


    // ==========================================
    // 📊 GLOBAL KPIs
    // ==========================================
    get pendingCount() {
        if (!this.projectData) return 0;
        return this.projectData.reduce((count, p) => count + (p.candidates ? p.candidates.length : 0), 0);
    }

    get totalHours() {
        if (!this.projectData) return '0.0';
        let hours = 0;
        this.projectData.forEach(p => {
            if (p.candidates) p.candidates.forEach(c => hours += (c.totalWeeklyHours || 0));
        });
        return hours.toFixed(1);
    }

    // ==========================================
    // 🗂️ SIDEBAR & WORKSPACE GETTERS
    // ==========================================
    @track projectSidebarPage = 1;
    projectSidebarPageSize = 6;

    get totalProjectSidebarPages() {
        return Math.max(1, Math.ceil((this.projectData?.length || 0) / this.projectSidebarPageSize));
    }

    get isProjectSidebarFirstPage() {
        return this.projectSidebarPage === 1;
    }

    get isProjectSidebarLastPage() {
        return this.projectSidebarPage >= this.totalProjectSidebarPages;
    }

    get projectSidebarPaginationVisible() {
        return this.totalProjectSidebarPages > 1;
    }

    get projectSidebarIndexStart() {
        return this.projectData && this.projectData.length > 0 ? ((this.projectSidebarPage - 1) * this.projectSidebarPageSize) + 1 : 0;
    }

    get projectSidebarIndexEnd() {
        return Math.min(this.projectData?.length || 0, this.projectSidebarPage * this.projectSidebarPageSize);
    }

    get projectSidebar() {
        if (!this.projectData) return [];
        return this.projectData.map(p => {
            return {
                ...p,
                className: p.projectId === this.selectedProjectId ? 'sidebar-item active' : 'sidebar-item',
                count: p.totalPendingTimesheets || 0, 
                hours: (p.totalPendingHours || 0).toFixed(1) 
            };
        });
    }

    get pagedProjectSidebar() {
        const sidebar = this.projectSidebar;
        const start = (this.projectSidebarPage - 1) * this.projectSidebarPageSize;
        return sidebar.slice(start, start + this.projectSidebarPageSize);
    }

    handleProjectSidebarPrev() {
        if (!this.isProjectSidebarFirstPage) {
            this.projectSidebarPage -= 1;
        }
    }

    handleProjectSidebarNext() {
        if (!this.isProjectSidebarLastPage) {
            this.projectSidebarPage += 1;
        }
    }

    get activeProject() {
        if (!this.projectData) return null;
        let project = this.projectData.find(p => p.projectId === this.selectedProjectId);
        
        if (project && project.candidates) {
            let filteredProject = { ...project };
            if (this.searchQuery) {
                filteredProject.candidates = project.candidates.filter(cand => 
                    cand.candidateName.toLowerCase().includes(this.searchQuery)
                );
            }
            return filteredProject;
        }
        return null;
    }

    get hasActiveCandidates() {
        return this.activeProject && this.activeProject.candidates && this.activeProject.candidates.length > 0;
    }

    get hasNoProjects() {
        return !this.projectSidebar || this.projectSidebar.length === 0;
    }

    get hasPendingTimesheetEntries() {
        return this.activeProject?.candidates?.some(cand => cand.hasPendingEntries);
    }

    get selectedWeekEntryIds() {
        if (!this.activeProject?.candidates) return [];
        return this.activeProject.candidates.reduce((ids, cand) => {
            cand.weekGroups?.forEach(week => {
                if (week.isSelected) {
                    week.weekDays?.forEach(day => {
                        day.tasks?.forEach(task => ids.push(...(task.entryIds || [])));
                    });
                }
            });
            return ids;
        }, []);
    }

    get hasSelectedWeekEntries() {
        return this.selectedWeekEntryIds.length > 0;
    }
    
    get isApproveAllDisabled() {
        return !this.hasActiveCandidates || !this.hasSelectedWeekEntries;
    }

    // ==========================================
    // ⚡ DATA WIRING (Sledgehammer + Grouping)
    // ==========================================
    @wire(getManagerContext)
    wiredManager({ data }) {
        if (data) this.managerInfo = data;
    }

    @wire(getActiveTasks)
    wiredTasks({ data }) { 
        if (data) this.taskOptions = data; 
    }

    // ==========================================
    // ⚡ DATA WIRING & SMART SORTING
    // ==========================================
    @wire(getApprovalsByStatus, { status: '$statusFilter' })
    wiredProjects(result) {
        this.wiredApprovalResults = result;
        this.isLoading = true;

        if (result.data) {
            const cleanData = JSON.parse(JSON.stringify(result.data));

            // Map the data to a temporary array first
            let mappedProjects = cleanData.map(proj => {
                let p = { ...proj };

                p.candidates = p.candidates?.map(cand => {
                    let taskMap = {}; // Aggregate by date and task

                    if (cand.entries) {
                        cand.entries.forEach(entry => {
                            const taskKey = entry.Date__c + '_' + (entry.Task__c || 'no-task');
                            
                            if (!taskMap[taskKey]) {
                                taskMap[taskKey] = {
                                    dateKey: entry.Date__c,
                                    taskId: entry.Task__c,
                                    taskName: entry.Task__r ? entry.Task__r.Name : 'General Task',
                                    totalHours: 0,
                                    entries: []
                                };
                            }

                            const hrs = entry.Hours_Worked_Number_Format__c || 0;
                            taskMap[taskKey].totalHours += hrs;
                            taskMap[taskKey].entries.push(entry);
                        });
                    }

                    let dateMap = {}; // Group by date

                    Object.values(taskMap).forEach(task => {
                        const dateKey = task.dateKey;
                        
                        if (!dateMap[dateKey]) {
                            const d = new Date(dateKey.split('-')[0], dateKey.split('-')[1] - 1, dateKey.split('-')[2]);
                            dateMap[dateKey] = {
                                dateKey: dateKey,
                                displayDay: d.toLocaleDateString('en-US', { weekday: 'short' }),
                                displayDate: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                                dayTotal: 0,
                                tasks: []
                            };
                        }

                        dateMap[dateKey].dayTotal += task.totalHours;
                        
                        dateMap[dateKey].tasks.push({
                            ...task,
                            hoursFormatted: task.totalHours.toFixed(1),
                            safeNotes: task.entries[0].Additional_Comments__c || '— No notes —',
                            isOvertimeDaily: task.totalHours > 8,
                            hoursClass: task.totalHours > 8 ? 'text-overtime' : 'text-standard',
                            Id: task.entries[0].Id,
                            Hours_Worked_Number_Format__c: task.totalHours,
                            Date__c: task.dateKey
                        });
                    });

                    const dateGroups = Object.values(dateMap).sort((a, b) => new Date(a.dateKey) - new Date(b.dateKey));

                    let weekMap = {};
                    Object.values(taskMap).forEach(task => {
                        if (!task.dateKey) return;
                        const parts = task.dateKey.split('-');
                        const entryDate = new Date(parts[0], parts[1] - 1, parts[2]);
                        const weekOffset = (entryDate.getDay() + 6) % 7;
                        const weekStart = new Date(entryDate);
                        weekStart.setDate(entryDate.getDate() - weekOffset);
                        const weekEnd = new Date(weekStart);
                        weekEnd.setDate(weekStart.getDate() + 6);

                        const weekKey = `${weekStart.toISOString().slice(0,10)}_${weekEnd.toISOString().slice(0,10)}`;
                        const displayWeek = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

                        if (!weekMap[weekKey]) {
                            weekMap[weekKey] = {
                                weekKey,
                                weekStart: weekStart.toISOString().slice(0,10),
                                weekEnd: weekEnd.toISOString().slice(0,10),
                                displayWeek,
                                totalHours: 0,
                                entryCount: 0,
                                isSelected: false,
                                entries: []
                            };
                        }

                        weekMap[weekKey].totalHours += task.totalHours;
                        weekMap[weekKey].entryCount += 1;

                        let displayDate = '';
                        let displayDay = '';
                        if (task.dateKey) {
                            const parts = task.dateKey.split('-');
                            const d = new Date(parts[0], parts[1] - 1, parts[2]);
                            displayDate = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
                            displayDay = d.toLocaleDateString('en-US', { weekday: 'short' });
                        }

                        weekMap[weekKey].entries.push({
                            ...task,
                            taskName: task.taskName,
                            safeNotes: task.entries[0].Additional_Comments__c || '— No notes —',
                            hoursFormatted: task.totalHours.toFixed(1),
                            displayDate: displayDate,
                            displayDay: displayDay
                        });
                    });

                    const weekGroups = Object.values(weekMap)
                        .sort((a, b) => new Date(a.weekStart) - new Date(b.weekStart))
                        .map(week => {
                            const uniqueDates = Array.from(new Set(week.entries.map(entry => entry.dateKey))).sort((a, b) => new Date(a) - new Date(b));
                            const weekDays = [];

                            uniqueDates.forEach(dateKey => {
                                const currentDate = new Date(dateKey);
                                const dayEntries = week.entries.filter(entry => entry.dateKey === dateKey);
                                const tasks = dayEntries.map(entry => ({
                                    id: String(entry.taskId || entry.taskName || 'no-task'),
                                    taskName: entry.taskName || 'General Task',
                                    hours: entry.totalHours,
                                    isOvertime: entry.totalHours > 8,
                                    notes: entry.entries[0]?.Additional_Comments__c || '— No notes —',
                                    entryIds: entry.entries.map(e => e.Id)
                                }));

                                weekDays.push({
                                    dateKey: dateKey,
                                    displayDay: currentDate.toLocaleDateString('en-US', { weekday: 'short' }),
                                    displayDate: currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                                    tasks: tasks,
                                    totalDayHours: tasks.reduce((sum, task) => sum + task.hours, 0)
                                });
                            });

                            return {
                                ...week,
                                totalHoursFormatted: week.totalHours.toFixed(1),
                                isExpanded: false,
                                chevronIcon: 'utility:chevronright',
                                weekDays: weekDays
                            };
                        });

                    const entryStatuses = new Set((cand.entries || []).map(entry => entry.Time_Status__c || entry.Approval_Status__c || 'Submitted'));
                    const hasPendingEntries = entryStatuses.has('Submitted');
                    let candidateStatus = 'Mixed';
                    if (entryStatuses.size === 1) {
                        const singleStatus = Array.from(entryStatuses)[0];
                        if (singleStatus === 'Submitted') candidateStatus = 'Pending';
                        else if (singleStatus === 'Approved') candidateStatus = 'Approved';
                        else if (singleStatus === 'Rejected') candidateStatus = 'Rejected';
                        else candidateStatus = singleStatus;
                    }
                    const isApproved = candidateStatus === 'Approved';
                    const isRejected = candidateStatus === 'Rejected';
                    const isMixed = candidateStatus === 'Mixed';
                    const isPending = candidateStatus === 'Pending';

                    const enhancedWeekGroups = weekGroups.map(week => {
                        const weekHasPendingEntries = week.entries.some(task => task.entries.some(entry => entry.Time_Status__c === 'Submitted'));
                        return { ...week, hasPendingEntries: weekHasPendingEntries };
                    });

                    return { 
                        ...cand, 
                        isExpanded: false, 
                        chevronIcon: 'utility:chevronright', 
                        parentProjectId: p.projectId, 
                        dateGroups: dateGroups,
                        weekGroups: enhancedWeekGroups,
                        hasPendingEntries: hasPendingEntries,
                        candidateStatus: candidateStatus,
                        isApproved: isApproved,
                        isRejected: isRejected,
                        isMixed: isMixed,
                        isPending: isPending
                    };
                });
                return p;
            });

            // 🌟 NEW: ENTERPRISE SMART SORTING
            mappedProjects.sort((a, b) => {
                const aHasPending = (a.candidates && a.candidates.length > 0) ? 1 : 0;
                const bHasPending = (b.candidates && b.candidates.length > 0) ? 1 : 0;

                // 1st Priority: Push projects with pending items to the top
                if (aHasPending !== bHasPending) {
                    return bHasPending - aHasPending; 
                }
                
                // 2nd Priority: If both have pending (or both don't), sort Alphabetically
                return a.projectName.localeCompare(b.projectName);
            });

            // Assign the perfectly sorted array to the UI
            this.projectData = mappedProjects;

            // 🌟 AUTO-SELECT: Now automatically highlights the top-most URGENT project
            if (this.projectData.length > 0 && !this.selectedProjectId) {
                this.selectedProjectId = this.projectData[0].projectId;
            }

            // Keep sidebar pagination on the page containing the selected project.
            const selectedIndex = this.projectData.findIndex(p => p.projectId === this.selectedProjectId);
            this.projectSidebarPage = selectedIndex >= 0 ? Math.floor(selectedIndex / this.projectSidebarPageSize) + 1 : 1;

            this.isLoading = false;
        } else if (result.error) {
            this.showToast('Error', result.error.body?.message, 'error');
            this.isLoading = false;
        }
    }

    // ==========================================
    // 🎛️ UI INTERACTION LOGIC
    // ==========================================
    handleSearch(event) {
        this.searchQuery = event.target.value.toLowerCase();
    }

    handleProjectSelect(event) {
        this.selectedProjectId = event.currentTarget.dataset.projectid;
    }

    handleWeekSelection(event) {
        event.stopPropagation();
        const candidateId = event.currentTarget.dataset.candidateid;
        const weekKey = event.currentTarget.dataset.weekkey;
        const checked = event.target.checked;

        this.projectData = this.projectData.map(proj => {
            if (proj.projectId !== this.selectedProjectId) return proj;

            const updatedCandidates = proj.candidates?.map(cand => {
                if (cand.candidateId !== candidateId) return cand;
                const updatedWeekGroups = cand.weekGroups?.map(week => {
                    if (week.weekKey !== weekKey) return week;
                    return { ...week, isSelected: checked };
                });
                return { ...cand, weekGroups: updatedWeekGroups };
            });

            return { ...proj, candidates: updatedCandidates };
        });
    }

    handleWeekToggle(event) {
        const candidateId = event.currentTarget.dataset.candidateid;
        const weekKey = event.currentTarget.dataset.weekkey;

        this.projectData = this.projectData.map(proj => {
            if (proj.projectId !== this.selectedProjectId) return proj;

            const updatedCandidates = proj.candidates?.map(cand => {
                if (cand.candidateId !== candidateId) return cand;
                const updatedWeekGroups = cand.weekGroups?.map(week => {
                    if (week.weekKey !== weekKey) return week;
                    const nextExpanded = !week.isExpanded;
                    return { 
                        ...week, 
                        isExpanded: nextExpanded,
                        chevronIcon: nextExpanded ? 'utility:chevrondown' : 'utility:chevronright'
                    };
                });
                return { ...cand, weekGroups: updatedWeekGroups };
            });

            return { ...proj, candidates: updatedCandidates };
        });
    }

    // 🌟 FIXED: Ensures instantaneous deep-copy toggle
    toggleAccordion(event) {
        const candidateId = event.currentTarget.dataset.candidateid;
        
        this.projectData = this.projectData.map(proj => {
            if (proj.projectId !== this.selectedProjectId) return proj; // Optimization
            
            const updatedCandidates = proj.candidates?.map(cand => {
                if (cand.candidateId === candidateId) {
                    const nextState = !cand.isExpanded;
                    return {
                        ...cand,
                        isExpanded: nextState,
                        chevronIcon: nextState ? 'utility:chevrondown' : 'utility:chevronright'
                    };
                }
                return cand;
            });
            return { ...proj, candidates: updatedCandidates };
        });
    }

    preventToggle(event) { 
        event.stopPropagation(); 
    }

    // ==========================================
    // ✅ ACTIONS (Approve, Reject, Split)
    // ==========================================
    handleApprove(event) {
        this.preventToggle(event);
        this.isLoading = true;
        processTimesheets({ 
            projectId: event.currentTarget.dataset.projectid, 
            candidateId: event.currentTarget.dataset.candidateid, 
            action: 'Approve', 
            rejectReason: '' 
        })
        .then(() => {
            this.showToast('Success', 'Approved', 'success');
            return refreshApex(this.wiredApprovalResults);
        })
        .catch(err => {
            this.showToast('Error', err.body?.message, 'error');
            this.isLoading = false;
        });
    }

    handleApproveWeek(event) {
        this.preventToggle(event);
        const candidateId = event.currentTarget.dataset.candidateid;
        const weekKey = event.currentTarget.dataset.weekkey;

        const week = this.activeProject.candidates
            .find(cand => cand.candidateId === candidateId)?.weekGroups
            .find(w => w.weekKey === weekKey);

        if (!week || !week.entries?.length) {
            this.showToast('Info', 'No entries found to approve for this week.', 'info');
            return;
        }

        const entryIds = week.entries.flatMap(entry => entry.entries?.map(e => e.Id) || []);
        if (!entryIds.length) {
            this.showToast('Info', 'No entries found to approve for this week.', 'info');
            return;
        }

        this.isLoading = true;
        processTimesheetsByIds({ entryIds, action: 'Approve' })
            .then(() => {
                this.showToast('Success', `Approved ${entryIds.length} time entries`, 'success');
                return refreshApex(this.wiredApprovalResults);
            })
            .then(() => {
                this.isLoading = false;
            })
            .catch(error => {
                this.showToast('Error', error.body?.message || 'Some approvals failed.', 'error');
                this.isLoading = false;
            });
    }

    handleApproveAll(event) {
        this.preventToggle(event);
        const entryIds = this.selectedWeekEntryIds;
        if (!entryIds.length) {
            this.showToast('Info', 'Please select at least one week to approve.', 'info');
            return;
        }

        this.isLoading = true;
        processTimesheetsByIds({ entryIds, action: 'Approve' })
            .then(() => {
                this.showToast('Success', `Approved ${entryIds.length} time entries`, 'success');
                return refreshApex(this.wiredApprovalResults);
            })
            .then(() => {
                this.isLoading = false;
            })
            .catch(error => {
                this.showToast('Error', error.body?.message || 'Some approvals failed.', 'error');
                this.isLoading = false;
            });
    }

    handleRejectWeek(event) {
        this.preventToggle(event);
        const candidateId = event.currentTarget.dataset.candidateid;
        const weekKey = event.currentTarget.dataset.weekkey;

        this.activeRejectCandidateId = candidateId;
        this.activeRejectProjectId = this.selectedProjectId;
        this.rejectTargetType = 'timesheet';
        this.rejectReason = '';
        this.isRejectModalOpen = true;

        // Store the week key for later use
        this.activeRejectWeekKey = weekKey;
    }

    handleApproveProjectExpenses() {
        if (!this.selectedExpenseProjectId) {
            this.showToast('Info', 'Please select an expense project first.', 'info');
            return;
        }
        this.isLoading = true;
        processExpenses({ projectId: this.selectedExpenseProjectId, candidateId: null, action: 'Approve', rejectReason: '' })
            .then(() => {
                this.showToast('Success', 'Approved all project expenses.', 'success');
                return refreshApex(this.wiredExpensesResult);
            })
            .then(() => {
                this.isLoading = false;
            })
            .catch(error => {
                this.showToast('Error', error.body?.message || 'Some expense approvals failed.', 'error');
                this.isLoading = false;
            });
    }

    handleApproveCandidateExpenses(event) {
        this.preventToggle(event);
        const candidateId = event.currentTarget.dataset.candidateid;
        if (!candidateId) {
            this.showToast('Info', 'Please select an expense candidate to approve.', 'info');
            return;
        }
        this.isLoading = true;
        processExpenses({ projectId: this.selectedExpenseProjectId, candidateId, action: 'Approve', rejectReason: '' })
            .then(() => {
                this.showToast('Success', 'Approved candidate expenses.', 'success');
                return refreshApex(this.wiredExpensesResult);
            })
            .then(() => {
                this.isLoading = false;
            })
            .catch(error => {
                this.showToast('Error', error.body?.message || 'Some expense approvals failed.', 'error');
                this.isLoading = false;
            });
    }

    handleReject(event) {
        this.preventToggle(event);
        this.rejectTargetType = 'timesheet';
        this.activeRejectCandidateId = event.currentTarget.dataset.candidateid;
        this.activeRejectProjectId = event.currentTarget.dataset.projectid;
        this.rejectReason = '';
        this.isRejectModalOpen = true;
    }

    handleRejectExpense(event) {
        this.preventToggle(event);
        this.rejectTargetType = 'expense';
        this.activeRejectCandidateId = event.currentTarget.dataset.candidateid;
        this.activeRejectProjectId = this.selectedExpenseProjectId;
        this.rejectReason = '';
        this.isRejectModalOpen = true;
    }

    closeRejectModal() { this.isRejectModalOpen = false; }
    handleRejectReasonChange(e) { this.rejectReason = e.target.value; }

    confirmReject() {
        this.isLoading = true;

        if (this.rejectTargetType === 'timesheet' && this.activeRejectWeekKey) {
            // Reject specific week
            const week = this.activeProject.candidates
                .find(cand => cand.candidateId === this.activeRejectCandidateId)?.weekGroups
                .find(w => w.weekKey === this.activeRejectWeekKey);

            if (week) {
                const entryIds = week.entries.flatMap(entry => entry.entries?.map(e => e.Id) || []);
                if (!entryIds.length) {
                    this.showToast('Info', 'No entries found to reject for this week.', 'info');
                    this.isLoading = false;
                    this.isRejectModalOpen = false;
                    return;
                }

                processTimesheetsByIds({ entryIds, action: 'Reject', rejectReason: this.rejectReason })
                    .then(() => {
                        this.isRejectModalOpen = false;
                        this.showToast('Success', `Rejected ${entryIds.length} time entries`, 'success');
                        return refreshApex(this.wiredApprovalResults);
                    })
                    .then(() => {
                        this.isLoading = false;
                        this.activeRejectWeekKey = null;
                    })
                    .catch(err => {
                        this.showToast('Error', err.body?.message || 'Time entries could not be rejected.', 'error');
                        this.isLoading = false;
                    });
            } else {
                this.showToast('Error', 'Selected week could not be found.', 'error');
                this.isLoading = false;
                this.isRejectModalOpen = false;
            }
        } else {
            const actionPromise = this.rejectTargetType === 'expense'
                ? processExpenses({ projectId: this.activeRejectProjectId, candidateId: this.activeRejectCandidateId, action: 'Reject', rejectReason: this.rejectReason })
                : processTimesheets({ projectId: this.activeRejectProjectId, candidateId: this.activeRejectCandidateId, action: 'Reject', rejectReason: this.rejectReason });

            actionPromise
            .then(() => {
                this.isRejectModalOpen = false;
                this.showToast('Rejected', 'Record sent back', 'info');
                return this.rejectTargetType === 'expense'
                    ? refreshApex(this.wiredExpensesResult)
                    : refreshApex(this.wiredApprovalResults);
            })
            .then(() => {
                this.isLoading = false;
            })
            .catch(err => {
                this.showToast('Error', err.body?.message, 'error');
                this.isLoading = false;
            });
        }
    }

    showToast(t, m, v) { this.dispatchEvent(new ShowToastEvent({ title: t, message: m, variant: v })); }
}