import { LightningElement, track, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation'; // 🌟 Required for Attachment Previews
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';
import getApprovalData from '@salesforce/apex/TimesheetAdminController.getApprovalData';
import processTimesheetAction from '@salesforce/apex/TimesheetAdminController.processTimesheetAction';
import processExpenseAction from '@salesforce/apex/TimesheetAdminController.processExpenseAction';

export default class TimesheetAdminPortal extends NavigationMixin(LightningElement) {
    
    @track dashboardData;
    wiredResult;
    isLoading = true;

    // --- State Management ---
    @track activeTab = 'timesheet'; 
    @track selectedProjectId = null;
    @track expandedCandidateId = null; 
    @track expandedWeekId = null; 
    @track selectedRecordIds = [];

    // 🌟 ENTERPRISE GLOBAL SELECTION
    @track globalSelectedItems = []; 
    @track isPreviewModalOpen = false;

    // --- Filters ---
    @track statusFilter = 'Submitted'; 
    @track searchQuery = '';
    @track projectTaskFilter = 'All';

    // --- Modal State ---
    @track isNotesModalOpen = false;
    @track activeNotes = '';

    // 🌟 ADD THESE TWO NEW VARIABLES FOR THE RECEIPT POP-UP
    @track isReceiptModalOpen = false;
    @track receiptUrl = '';


    statusOptions = [
        { label: 'Pending Approval', value: 'Submitted' },
        { label: 'Approved', value: 'Approved' },
        { label: 'Rejected', value: 'Rejected' },
        { label: 'All', value: 'All' }
    ];

    @wire(getApprovalData)
    wiredApprovalData(result) {
        this.wiredResult = result;
        if (result.data) this.dashboardData = result.data;
        this.isLoading = false;
    }

    // ==========================================
    // DYNAMIC METRICS & LISTS
    // ==========================================
    get globalMetrics() {
        let metrics = { mainCount: 0, secondaryValue: 0, mainLabel: '', secondaryLabel: '' };
        if (!this.processedProjects) return metrics;

        if(this.activeTab === 'timesheet') {
            metrics.mainLabel = 'PENDING WEEKS';
            metrics.secondaryLabel = 'PENDING HOURS';
            this.processedProjects.forEach(p => { metrics.mainCount += p.totalPendingItems; metrics.secondaryValue += p.totalPendingValue; });
            metrics.secondaryValue = metrics.secondaryValue.toFixed(1) + ' Hrs';
        } else {
            metrics.mainLabel = 'PENDING EXPENSES';
            metrics.secondaryLabel = 'PENDING AMOUNT';
            this.processedProjects.forEach(p => { metrics.mainCount += p.totalPendingItems; metrics.secondaryValue += p.totalPendingValue; });
            metrics.secondaryValue = '$' + metrics.secondaryValue.toLocaleString(undefined, {minimumFractionDigits: 2});
        }
        return metrics;
    }

    get processedProjects() {
        if (!this.dashboardData || !this.dashboardData.projects) return [];

        return this.dashboardData.projects.map(proj => {
            let matchingResources = [];
            let totalPendingItems = 0; // Weeks OR Expense Count
            let totalPendingValue = 0; // Hours OR Amount

            proj.resources.forEach(res => {
                const matchesSearch = !this.searchQuery || res.candidateName.toLowerCase().includes(this.searchQuery);
                if (!matchesSearch) return;

                let itemsToFilter = this.activeTab === 'timesheet' ? res.timeEntries : res.expenses;
                let filteredItems = itemsToFilter.filter(item => {
                    let statusField = this.activeTab === 'timesheet' ? item.Time_Status__c : item.Status__c;
                    return this.statusFilter === 'All' || statusField === this.statusFilter;
                });

                if (filteredItems.length > 0) {
                    if (this.activeTab === 'timesheet') {
                        let weekSet = new Set();
                        filteredItems.forEach(item => {
                            if (item.Time_Status__c === 'Submitted') {
                                let dObj = new Date(item.Date__c.split('T')[0]); dObj.setDate(dObj.getDate() - (dObj.getDay() || 7) + 1);
                                weekSet.add(`${res.resourceId}_${dObj.getTime()}`); 
                                totalPendingValue += (parseFloat(item.Hours_Worked_Number_Format__c) || 0);
                            }
                        });
                        totalPendingItems += weekSet.size;
                    } else {
                        // Expenses Math
                        filteredItems.forEach(exp => {
                            if (exp.Status__c === 'Submitted') {
                                totalPendingItems++;
                                totalPendingValue += (parseFloat(exp.Amount__c) || 0);
                            }
                        });
                    }
                    matchingResources.push({ ...res, displayItems: filteredItems });
                }
            });

            return { 
                ...proj, matchingResources, totalPendingItems, totalPendingValue,
                hasData: matchingResources.length > 0,
                cardClass: proj.projectId === this.selectedProjectId ? 'saas-project-card active' : 'saas-project-card',
                cardLabelItems: this.activeTab === 'timesheet' ? 'Pending Weeks' : 'Pending Expenses',
                cardLabelValue: this.activeTab === 'timesheet' ? `${totalPendingValue.toFixed(1)} Hrs` : `$${totalPendingValue.toLocaleString()}`
            };
        }).filter(proj => proj.hasData);
    }

    // 🌟 1. INJECT DATA DIRECTLY FOR THE PREVIEW MODAL
    get activeProjectDetails() {
        if (!this.selectedProjectId) return null;
        let project = this.processedProjects.find(p => p.projectId === this.selectedProjectId);
        if (!project) return null;

        let projectClone = JSON.parse(JSON.stringify(project));

        projectClone.matchingResources = projectClone.matchingResources.map(res => {
            res.isExpanded = res.resourceId === this.expandedCandidateId;
            res.iconName = res.isExpanded ? 'utility:chevrondown' : 'utility:chevronright';
            
            let parts = (res.candidateName || 'U C').split(' ');
            res.initials = parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : parts[0].substring(0,2).toUpperCase();
            
            if (this.activeTab === 'timesheet') {
                res.weeklyData = this.groupTimeEntriesByWeek(res.displayItems);
                res.weeklyData = res.weeklyData.map(w => {
                    w.uid = `TS_${res.resourceId}_${w.weekId}`;
                    w.isChecked = this.globalSelectedItems.some(item => item.uid === w.uid);
                    
                    // 🌟 FIX: Inject exact data to prevent blank Preview Modals
                    w.projectName = projectClone.projectName;
                    w.candidateName = res.candidateName;
                    w.itemLabel = w.weekLabel;
                    
                    return w;
                });
                res.totalValueDisplay = res.weeklyData.reduce((acc, w) => acc + w.weekTotalHours, 0).toFixed(1) + ' Hrs';
            } else {
                res.weeklyData = this.groupExpensesByWeek(res.displayItems);
                res.weeklyData = res.weeklyData.map(w => {
                    w.expenseList = w.expenseList.map(exp => {
                        exp.uid = `EXP_${exp.Id}`;
                        exp.isChecked = this.globalSelectedItems.some(item => item.uid === exp.uid);
                        
                        // 🌟 FIX: Inject exact data to prevent blank Preview Modals
                        exp.projectName = projectClone.projectName;
                        exp.candidateName = res.candidateName;
                        exp.itemLabel = exp.Expense_Date__c;
                        
                        return exp;
                    });
                    return w;
                });
                res.totalValueDisplay = '$' + res.weeklyData.reduce((acc, w) => acc + w.weekTotalAmount, 0).toLocaleString();
            }
            return res;
        });
        return projectClone;
    }
    get showBulkActionBar() { return this.globalSelectedItems.length > 0; }
    get selectedLabel() { return this.activeTab === 'timesheet' ? 'Weeks Selected' : 'Expenses Selected'; }

   get previewData() {
        if (!this.globalSelectedItems || this.globalSelectedItems.length === 0) return null;

        let pMap = new Map();
        let grandTotal = 0;
        const isTime = this.activeTab === 'timesheet';
        const formatTotal = (val) => isTime ? `${val.toFixed(1)} Hrs` : `$${val.toLocaleString(undefined, {minimumFractionDigits: 2})}`;

        this.globalSelectedItems.forEach(item => {
            grandTotal += item.totalValue;

            // Group by Project
            if (!pMap.has(item.project)) pMap.set(item.project, { projectName: item.project, projectTotal: 0, candidates: new Map() });
            let pData = pMap.get(item.project);
            pData.projectTotal += item.totalValue;

            // Group by Candidate
            let cMap = pData.candidates;
            if (!cMap.has(item.candidate)) cMap.set(item.candidate, { candidateName: item.candidate, candidateTotal: 0, items: [] });
            let cData = cMap.get(item.candidate);
            cData.candidateTotal += item.totalValue;

            cData.items.push(item);
        });

        return {
            grandTotalDisplay: formatTotal(grandTotal),
            projects: Array.from(pMap.values()).map(p => ({
                projectName: p.projectName,
                projectTotalDisplay: formatTotal(p.projectTotal),
                candidates: Array.from(p.candidates.values()).map(c => ({
                    candidateName: c.candidateName,
                    candidateTotalDisplay: formatTotal(c.candidateTotal),
                    items: c.items.map(item => ({
                        ...item,
                        itemTotalDisplay: formatTotal(item.totalValue),
                        hasTasks: item.taskBreakdown && item.taskBreakdown.length > 0
                    }))
                }))
            }))
        };
    }

    handleCheckboxChange(e) {
        const isChecked = e.target.checked;
        const ds = e.currentTarget.dataset;
        let newSelection = [...this.globalSelectedItems];

        if (isChecked) {
            if (!newSelection.some(item => item.uid === ds.uid)) {
                
                let totalValue = 0;
                let taskBreakdown = [];
                const isTime = this.activeTab === 'timesheet';

                // 🌟 ENTERPRISE FIX: Lookup the specific record to extract Hours and Tasks
                if (this.activeProjectDetails) {
                    for (let res of this.activeProjectDetails.matchingResources) {
                        if (isTime) {
                            let w = res.weeklyData.find(week => week.uid === ds.uid);
                            if (w) {
                                totalValue = w.weekTotalHours;
                                let taskMap = new Map();
                                w.days.forEach(d => {
                                    if(d.tasks) d.tasks.forEach(t => taskMap.set(t.taskName, (taskMap.get(t.taskName) || 0) + t.hours));
                                });
                                taskBreakdown = Array.from(taskMap.keys()).map(k => ({ 
                                    label: k, 
                                    displayStr: `${k}: ${taskMap.get(k).toFixed(1)} hrs` 
                                }));
                                break;
                            }
                        } else {
                            for(let w of res.weeklyData) {
                                let exp = w.expenseList.find(x => x.uid === ds.uid);
                                if (exp) {
                                    totalValue = parseFloat(exp.Amount__c) || 0;
                                    taskBreakdown = [{ label: exp.Category__c, displayStr: exp.Category__c }];
                                    break;
                                }
                            }
                        }
                    }
                }

                newSelection.push({
                    uid: ds.uid,
                    ids: ds.ids.split(','),
                    project: ds.project,
                    candidate: ds.candidate,
                    itemName: ds.itemname,
                    totalValue: totalValue,
                    taskBreakdown: taskBreakdown
                });
            }
        } else {
            newSelection = newSelection.filter(item => item.uid !== ds.uid);
        }
        
        this.globalSelectedItems = newSelection;
    }
    processBulkAction(actionType) {
        let allIds = [];
        this.globalSelectedItems.forEach(item => allIds = allIds.concat(item.ids));
        this.executeAction(allIds.join(','), actionType, this.activeTab);
        this.clearSelection(); 
        this.closePreviewModal();
    }

    // 🌟 BULK ACTIONS
    handleFloatingApprove() { this.processBulkAction('Approve'); }
    handleFloatingReject() { this.processBulkAction('Reject'); }

    // ==========================================
    // GROUPING ENGINES
    // ==========================================
    groupTimeEntriesByWeek(entries) {
        let weekMap = new Map();
        entries.forEach(entry => {
            let dStr = entry.Date__c; 
            if(!dStr) return;
            
            let taskName = entry.Task__r?.Name || 'Uncategorized';
            if (this.projectTaskFilter !== 'All' && taskName !== this.projectTaskFilter) return;

            let dObj = new Date(dStr.split('T')[0]); 
            dObj.setDate(dObj.getDate() - (dObj.getDay() || 7) + 1);
            let wKey = dObj.toISOString().split('T')[0];

            if (!weekMap.has(wKey)) {
                let dEnd = new Date(dObj); 
                dEnd.setDate(dObj.getDate() + 6);
                weekMap.set(wKey, { 
                    weekId: wKey, 
                    weekLabel: `${dObj.toLocaleDateString('en-US',{month:'short',day:'numeric'})} - ${dEnd.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`, 
                    weekTotalHours: 0, 
                    allEntryIds: [], 
                    daysMap: new Map() 
                });
            }
            
            let weekData = weekMap.get(wKey);
            let hours = parseFloat(entry.Hours_Worked_Number_Format__c) || 0;
            weekData.weekTotalHours += hours;
            weekData.allEntryIds.push(entry.Id);

            // 🌟 THE FIX: Inject the saas-day-row class and evaluate for weekends
            if(!weekData.daysMap.has(dStr)) {
                let entryDate = new Date(dStr.split('T')[0]);
                let dayOfWeek = entryDate.getDay();
                let isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
                
                weekData.daysMap.set(dStr, { 
                    dateId: dStr, 
                    dayLabel: entryDate.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }), 
                    dayTotalHours: 0, 
                    tasksMap: new Map(),
                    rowClass: isWeekend ? 'saas-day-row saas-weekend-row' : 'saas-day-row' 
                });
            }
            
            let dayData = weekData.daysMap.get(dStr);
            dayData.dayTotalHours += hours;
            
            if(!dayData.tasksMap.has(taskName)) {
                dayData.tasksMap.set(taskName, { taskName, hours: 0, comments: [] });
            }
            
            dayData.tasksMap.get(taskName).hours += hours;
            
            if (entry.Additional_Comments__c) {
                dayData.tasksMap.get(taskName).comments.push(entry.Additional_Comments__c);
            }
        });

        return this.formatWeekOutput(weekMap, entries, 'Time_Status__c', 'daysMap', this.expandedWeekId);
    }

    groupExpensesByWeek(entries) {
        let weekMap = new Map();
        entries.forEach(exp => {
            let dStr = exp.Expense_Date__c; if(!dStr) return;
            let dObj = new Date(dStr.split('T')[0]); dObj.setDate(dObj.getDate() - (dObj.getDay() || 7) + 1);
            let wKey = dObj.toISOString().split('T')[0];

            if (!weekMap.has(wKey)) {
                let dEnd = new Date(dObj); dEnd.setDate(dObj.getDate() + 6);
                weekMap.set(wKey, { weekId: wKey, weekLabel: `${dObj.toLocaleDateString('en-US',{month:'short',day:'numeric'})} - ${dEnd.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`, weekTotalAmount: 0, allEntryIds: [], expenseList: [] });
            }
            
            let weekData = weekMap.get(wKey);
            weekData.weekTotalAmount += (parseFloat(exp.Amount__c) || 0);
            weekData.allEntryIds.push(exp.Id);
            
            // Link Attachments from the Apex Map
            let attachments = this.dashboardData.expenseToAttachments ? this.dashboardData.expenseToAttachments[exp.Id] : null;
            
            weekData.expenseList.push({
                ...exp,
                hasComments: !!exp.Description__c || !!exp.Comments__c,
                combinedComments: [exp.Description__c, exp.Comments__c].filter(Boolean).join(' | '),
                hasReceipt: attachments && attachments.length > 0,
                receiptIds: attachments ? attachments.join(',') : ''
            });
        });

        return this.formatWeekOutput(weekMap, entries, 'Status__c', 'expenseList', this.expandedWeekId);
    }

    formatWeekOutput(weekMap, entries, statusField, dataField, openWeekId) {
        return Array.from(weekMap.values()).map(w => {
            w.isExpanded = w.weekId === openWeekId;
            w.iconName = w.isExpanded ? 'utility:chevrondown' : 'utility:chevronright';
            
            let statuses = new Set(entries.filter(e => w.allEntryIds.includes(e.Id)).map(e => e[statusField]));
            
            if (statuses.size > 1) { 
                w.weekStatus = 'Mixed'; 
                w.statusCSS = 'saas-pill saas-pill-mixed'; 
            } else if (statuses.size === 1) {
                const s = Array.from(statuses)[0]; 
                w.weekStatus = s;
                w.statusCSS = s === 'Submitted' ? 'saas-pill saas-pill-warning' : 
                             (s === 'Approved' ? 'saas-pill saas-pill-success' : 'saas-pill saas-pill-error');
            }

            // 🌟 NEW: Determine if the entire week needs approval actions
            w.isPending = (w.weekStatus === 'Submitted' || w.weekStatus === 'Mixed');

            if(dataField === 'daysMap') {
                w.days = Array.from(w.daysMap.values()).map(d => {
                    d.tasks = Array.from(d.tasksMap.values()).map(t => ({ ...t, hasComments: t.comments.length > 0, combinedComments: t.comments.join('\n\n---\n\n') }));
                    
                    // 🌟 BUG FIX: Restore the visibility flag so entries actually show up!
                    d.hasEntries = d.tasks.length > 0; 
                    
                    return d;
                }).sort((a,b) => a.dateId.localeCompare(b.dateId));
            }

            if(dataField === 'expenseList') {
                w.expenseList = w.expenseList.map(exp => {
                    // 🌟 NEW: Determine if individual expense needs approval actions
                    exp.isPending = (exp.Status__c === 'Submitted');
                    return exp;
                });
            }

            return w;
        }).sort((a,b) => b.weekId.localeCompare(a.weekId));
    }

    // ==========================================
    // HANDLERS
    // ==========================================
    stopProp(e) { e.stopPropagation(); } 
    handleSearchChange(e) { this.searchQuery = e.detail.value.toLowerCase(); this.selectedProjectId = null; }
    handleStatusChange(e) { this.statusFilter = e.detail.value; this.selectedProjectId = null; }
    handleProjectTaskFilter(e) { this.projectTaskFilter = e.detail.value; }

    clearSelection() { 
        this.globalSelectedItems = []; 
        
        // LWC sometimes caches Checkbox DOM states. We manually wipe them clean here.
        const checkboxes = this.template.querySelectorAll('.saas-checkbox');
        if (checkboxes) {
            checkboxes.forEach(cb => { cb.checked = false; });
        }
    }
    openPreviewModal() { this.isPreviewModalOpen = true; }
    closePreviewModal() { this.isPreviewModalOpen = false; }

    setTabTimesheet() { this.activeTab = 'timesheet'; this.clearSelection(); this.resetState(); }
    setTabExpense() { this.activeTab = 'expense'; this.clearSelection(); this.resetState(); }
    
    get isTimesheetTab() { return this.activeTab === 'timesheet'; }
    get isExpenseTab() { return this.activeTab === 'expense'; }
    // --- SaaS Navigation Handlers ---
    get tabTimesheetClass() { 
        return this.activeTab === 'timesheet' ? 'saas-tab active' : 'saas-tab'; 
    }
    
    get tabExpenseClass() { 
        return this.activeTab === 'expense' ? 'saas-tab active' : 'saas-tab'; 
    }
    resetState() {
        this.projectTaskFilter = 'All';
        this.expandedCandidateId = null; 
        this.expandedWeekId = null;
        this.selectedRecordIds = []; // Clear checkboxes
    }

    handleProjectSelect(e) { 
        this.selectedProjectId = e.currentTarget.dataset.id; 
        this.resetState(); 
        // 🛑 Notice we DO NOT clear the selection here! This allows cross-project selections.
    }
    handleCandidateToggle(e) { const id = e.currentTarget.dataset.id; this.expandedCandidateId = (this.expandedCandidateId === id) ? null : id; this.expandedWeekId = null; }
    handleWeekToggle(e) { const id = e.currentTarget.dataset.id; this.expandedWeekId = (this.expandedWeekId === id) ? null : id; }

    // --- Actions ---
    handleApprove(e) { e.stopPropagation(); this.executeAction(e.currentTarget.dataset.ids, 'Approve', e.currentTarget.dataset.type); }
    handleReject(e) { e.stopPropagation(); this.executeAction(e.currentTarget.dataset.ids, 'Reject', e.currentTarget.dataset.type); }

    executeAction(idString, actionType, dataType) {
        if (!idString) return;
        this.isLoading = true;
        let idArray = idString.split(','); 
        let actionMethod = (dataType === 'expense') ? processExpenseAction : processTimesheetAction;

        actionMethod({ [dataType === 'expense' ? 'expenseIds' : 'entryIds']: idArray, action: actionType })
            .then(() => {
                this.dispatchEvent(new ShowToastEvent({ title: 'Success', message: `Successfully ${actionType}d items.`, variant: 'success' }));
                return refreshApex(this.wiredResult);
            })
            .catch(err => this.dispatchEvent(new ShowToastEvent({ title: 'Error', message: err.body?.message, variant: 'error' })))
            .finally(() => this.isLoading = false);
    }

    // 🌟 ENTERPRISE FILE PREVIEW (Native Salesforce PDF/Image Viewer)
    // 🌟 ENTERPRISE FILE PREVIEW (Native Salesforce PDF/Image Viewer)
    // 🌟 BULLETPROOF ENTERPRISE FILE PREVIEW
    // 🌟 BULLETPROOF FILE PREVIEW (Direct URL Fallback)
   // 🌟 SAME-PAGE IFRAME PREVIEW FOR SITES/COMMUNITIES
    // 🌟 BULLETPROOF SITE FILE VIEWER (Bypasses Clickjack Protection)
    handlePreviewReceipt(e) {
        e.stopPropagation();
        
        try {
            const docIdsString = e.currentTarget.dataset.docids || e.target.dataset.docids;
            
            if (!docIdsString || docIdsString === 'null' || docIdsString === 'undefined') {
                this.dispatchEvent(new ShowToastEvent({ title: 'No File Found', message: 'There are no files attached.', variant: 'warning' }));
                return;
            }

            const firstDocId = docIdsString.split(',')[0];

            // 🌟 THE FIX: The Shepherd URL with operationContext. 
            // We force this into a new tab. Browsers handle PDFs and Images natively here.
            const fileUrl = `/sfc/servlet.shepherd/document/download/${firstDocId}?operationContext=S1`;
            
            window.open(fileUrl, '_blank');
            
        } catch (error) {
            console.error('File Preview Crash: ', error);
        }
    }

    // 🌟 ADD THIS METHOD TO CLOSE THE MODAL
    closeReceiptModal() {
        this.isReceiptModalOpen = false;
        this.receiptUrl = '';
    }

    handleViewNotes(e) { this.activeNotes = e.currentTarget.dataset.comments; this.isNotesModalOpen = true; }
    closeNotesModal() { this.isNotesModalOpen = false; this.activeNotes = ''; }
}