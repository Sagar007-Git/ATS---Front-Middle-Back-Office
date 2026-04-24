import { LightningElement, track, wire } from 'lwc';
import { refreshApex } from '@salesforce/apex';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { NavigationMixin } from 'lightning/navigation';
import { getObjectInfo, getPicklistValues } from 'lightning/uiObjectInfoApi';

import getTimesheetData from '@salesforce/apex/TimesheetPortalController.getTimesheetData';
import saveTimeEntry from '@salesforce/apex/TimesheetPortalController.saveTimeEntry';
import moveTimeEntry from '@salesforce/apex/TimesheetPortalController.moveTimeEntry';
import deleteTimeEntry from '@salesforce/apex/TimesheetPortalController.deleteTimeEntry';
import submitWeek from '@salesforce/apex/TimesheetPortalController.submitWeek';
import saveExpense from '@salesforce/apex/TimesheetPortalController.saveExpense';
import deleteExpense from '@salesforce/apex/TimesheetPortalController.deleteExpense';
import EXPENSE_OBJECT from '@salesforce/schema/Expense__c';
import CATEGORY_FIELD from '@salesforce/schema/Expense__c.Category__c';

import getFilePreviewData from '@salesforce/apex/TimesheetPortalController.getFilePreviewData';

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE: Time Utilities
// ─────────────────────────────────────────────────────────────────────────────
const TimeUtils = {
    normalizeTime: function(timeValue) {
        if (timeValue === null || timeValue === undefined || timeValue === '') return null;
        if (typeof timeValue === 'number' || !String(timeValue).includes(':')) {
            const ms = parseInt(timeValue, 10);
            if (!isNaN(ms)) {
                const totalMins = Math.floor(ms / 60000);
                const h = Math.floor(totalMins / 60) % 24;
                const m = totalMins % 60;
                return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            }
        }
        let timeStr = String(timeValue).trim();
        const parts = timeStr.split(':');
        if (parts.length < 2) return null;
        const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
        if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    },
    formatTime12h: function(timeValue) {
        const n = this.normalizeTime(timeValue);
        if (!n) return '';
        const [h, m] = n.split(':').map(Number);
        return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    },
    toMinutes: function(timeValue) {
        const n = this.normalizeTime(timeValue);
        if (!n) return 0;
        const [h, m] = n.split(':').map(Number);
        return h * 60 + m;
    },
    rangesOverlap: function(sA, eA, sB, eB) {
        const sa = this.toMinutes(sA), ea = eA ? this.toMinutes(eA) : sa + 60;
        const sb = this.toMinutes(sB), eb = eB ? this.toMinutes(eB) : sb + 60;
        return Math.max(sa, sb) < Math.min(ea, eb);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE: Data Utilities
// ─────────────────────────────────────────────────────────────────────────────
const DataUtils = {
    deepClone: obj => obj ? JSON.parse(JSON.stringify(obj)) : obj,
    uniqueBy: (arr, fn) => {
        const s = new Set();
        return arr.filter(i => {
            const k = fn(i);
            return k && !s.has(k) && s.add(k);
        });
    },
    isValidSfId: id => !!(id && typeof id === 'string' && (id.trim().length === 15 || id.trim().length === 18) && /^[a-zA-Z0-9]+$/.test(id.trim())),
    getLocalIsoDate: (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    buildProjectNameMap: res => {
        const m = {};
        res.forEach(r => {
            if (r.Project__c) m[r.Project__c] = r.Project__r?.Name || r.Name || '';
        });
        return m;
    }
};

export default class TimesheetPortal extends NavigationMixin(LightningElement) {
    @track contactId;
    @track contactName = '';
    @track contactTitle = '';

    // ==========================================
    // 🗂️ GLOBAL UI & NAVIGATION STATE
    // ==========================================
    @track activeTab = 'timesheet';
    @track activeView = 'weekly';
    @track listTimeframe = 'Weekly';
    @track currentStartDate = new Date();
    @track unreadNotifications = 3; 

    @track isPreviewModalOpen = false;
    @track isPreviewLoading = false;
    @track previewDataUrl = '';
    @track previewFileType = '';
    @track previewFileName = '';

    
    
    wiredResult;
    allProjectResources = [];
    allTimeEntries = [];
    allProjectTasks = [];
    allExpenses = [];
    
    _colorPalette = [
        { border: '#0176D3', dot: '#0176D3' },
        { border: '#41B658', dot: '#41B658' },
        { border: '#E96B54', dot: '#E96B54' },
        { border: '#7856FF', dot: '#7856FF' },
        { border: '#F29A2E', dot: '#F29A2E' }
    ];
    _projectColorMap = {};

    @track searchTerm = '';
    @track listSearchTerm = '';
    @track recordsPerPage = 20;
    @track totalRecords = 0;
    @track totalPages = 1;

    @track searchTerm = '';
    @track expandedProjectIds = [];

    // ==========================================
    // 📅 CALENDAR & TIMESHEET STATE
    // ==========================================
    @track currentDate = new Date(); 
    @track viewedDate = new Date();  
    @track miniCalendarWeeks = [];
    @track currentMonthLabel = '';
    @track dateHeaders = [];
    @track calendarColumns = [];
    @track weeklyTotalHours = '0.0';

    // 🌟 WEEKLY COPY/PASTE STATE
    @track copiedWeekEntries = null;
    @track copiedWeekStartDate = null;

    @track isEntryModalOpen = false;
    @track selectedEntryId = null;
    @track entryDate = '';
    @track entryProjectId = '';
    @track entryTaskId = '';
    @track entryStartTime = '09:00';
    @track entryEndTime = '17:00';
    @track entryBreakTime = 0;
    @track entryComments = '';
    @track entryDuration = '';

    _isDrawing = false;
    _drawStartY = 0;
    _dragStartMins = 0;
    @track ghostStyle = '';
    @track activeGhostId = null;
    @track resizeTooltip = { visible: false, text: '', style: '' };
    _isResizing = false;
    _resizeStartY = 0;
    _resizeStartHeight = 0;
    _resizingEntryId = null;
    _resizingEl = null;

    @track copiedEntry = null;
    @track isCutAction = false;
    cutEntryId = null;
    actionHistory = [];
    @track isUndoDisabled = true;
    @track selectedEntryIds = [];
    @track isBulkModalOpen = false;
    @track bulkType = '';
    @track inlineEditEntryId = null;

    @track isSubmitReviewOpen = false;
    @track submitSummary = [];
    @track submitTotalHours = '0.00';
    @track isAttested = false;
    @track isDeleteConfirmOpen = false;
    @track deleteType = '';
    pendingDeleteId = null;
    @track hoverCard = { visible: false };
    _hoverTimeout = null;
    _hoverEntryId = null;

    @track showDeleteModal = false;

    @track activeSidebarProjectId = null;

    @track isSaving = false; // Prevents double-clicking the save button

    // ==========================================
    // 💰 EXPENSE DASHBOARD STATE
    // ==========================================
    @track allRawExpenses = [];
    @track displayExpenses = [];
    @track expenseFilterType = 'month';
    @track expFilterStartDate = '';
    @track expFilterEndDate = '';
    @track activeStatusTab = 'All';

    // 🌟 3. UNDO & REDO STATE MANAGEMENT
    @track historyStack = [];
    @track redoStack = [];
    
    @track tabCounts = { all: 0, draft: 0, submitted: 0, approved: 0, rejected: 0, invoiced: 0 };
    @track kpiTotalApplied = '$0.00';
    @track kpiTotalDraft = '$0.00';
    @track kpiTotalPending = '$0.00';
    @track kpiTotalApproved = '$0.00';
    @track kpiTotalInvoiced = '$0.00';
    // 🌟 SAAS STATE MANAGEMENT
    @track listTimeframe = 'Weekly'; // CRITICAL: Must default to 'Weekly'

    @track isExpenseModalOpen = false;
    @track isMissingReceiptModalOpen = false;
    @track selectedExpenseId = null;
    @track expenseProjectId = '';
    @track expenseDate = '';
    @track expenseAmount = '';
    @track expenseCategory = '';
    @track expenseDescription = '';
    @track expenseComments = '';
    @track expenseStatus = 'Draft';
    @track attachedFileId = null;
    @track attachedFileName = '';
    fileBase64 = null;
    @track expenseCategoryOptions = [];
    expenseRecordTypeId;

    @track activeDatePreset = 'Month'; 
    @track activeView = 'grid';

    @track isDirty = false; // Tracks if the user has made unsaved changes

    recordsPerPageOptions = [
        { label: '10', value: '10' },
        { label: '20', value: '20' },
        { label: '50', value: '50' },
        { label: 'All', value: '1000' }
    ];
    _statusShortMap = { 'Draft': 'D', 'Submitted': 'S', 'Approved': 'A', 'Rejected': 'R' };

    @track isMiniCalendarOpen = true;

    // ==========================================
    // 🧮 BULLETPROOF EXPENSE PAGINATION
    // ==========================================
    @track currentExpPage = 1;
    @track expPageSize = 5;

    // 1. Calculate Total Pages safely
    get totalExpPages() {
        const total = this.displayExpenses ? this.displayExpenses.length : 0;
        return Math.ceil(total / Number(this.expPageSize)) || 1;
    }

    // 2. Slice the array for the current page
    get pagedExpenseList() {
        const list = this.displayExpenses || [];
        const size = Number(this.expPageSize);
        const page = Number(this.currentExpPage);
        const start = (page - 1) * size;
        return list.slice(start, start + size);
    }

    // 3. Button Disablement Logic
    get isFirstExpPage() { 
        return Number(this.currentExpPage) <= 1; 
    }
    get isLastExpPage() { 
        return Number(this.currentExpPage) >= this.totalExpPages; 
    }

    // 4. Action Handlers (Strictly using Number() to prevent string math bugs)
    handleExpPageSizeChange(event) {
        this.expPageSize = Number(event.target.value);
        this.currentExpPage = 1; // Always reset to page 1 when changing size
    }

    handlePrevExpPage() { 
        if (Number(this.currentExpPage) > 1) {
            this.currentExpPage = Number(this.currentExpPage) - 1; 
        }
    }
    
    handleNextExpPage() { 
        if (Number(this.currentExpPage) < this.totalExpPages) {
            this.currentExpPage = Number(this.currentExpPage) + 1; 
        }
    }

    get calendarToggleIcon() {
        return this.isMiniCalendarOpen ? 'utility:chevrondown' : 'utility:chevronright';
    }

    get isSaveDraftDisabled() {
        // Disabled if saving, or if no changes have been made to an existing draft
        return this.isSaving || !this.isDirty; 
    }

    get showDeleteButton() {
        // Only show delete if it's an existing Draft (not a brand new unsaved record)
        return this.expenseStatus === 'Draft' && this.selectedExpenseId && this.selectedExpenseId !== 'NEW';
    }
    // 🌟 WEEKLY COPY/PASTE GETTERS
    get isWeekCopied() { 
        return this.copiedWeekEntries !== null && this.copiedWeekEntries.length > 0; 
    }
    
    get isClipboardActive() { 
        return this.isEntryCopied || this.isWeekCopied; 
    }
    
    get copyWeekDisabled() {
        // Disables the Copy button if there are zero entries in the currently viewed week
        if (!this.dateHeaders || !this.dateHeaders.length) return true;
        const startStr = this.dateHeaders[0].dateValue;
        const endStr = this.dateHeaders[this.dateHeaders.length - 1].dateValue;
        return !this.allTimeEntries.some(e => e.Date__c >= startStr && e.Date__c <= endStr);
    }

    get isUndoDisabled() { return this.historyStack.length === 0; }
    get isRedoDisabled() { return this.redoStack.length === 0; }    

    toggleMiniCalendar() {
        this.isMiniCalendarOpen = !this.isMiniCalendarOpen;
    }

    saveStateToHistory() {
        this.historyStack.push(JSON.stringify(this.timesheetData));
        if (this.historyStack.length > 20) this.historyStack.shift(); 
        this.redoStack = []; // Any new action wipes the redo stack
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🚀 LIFECYCLE & APEX WIRE
    // ─────────────────────────────────────────────────────────────────────────
    connectedCallback() {
        const p = new URLSearchParams(window.location.search);
        this.contactId = p.get('contactId') || p.get('c__contactId');
        if (!DataUtils.isValidSfId(this.contactId)) {
            this.showToast('Authentication Error', 'Invalid Contact ID.', 'error');
            return;
        }
        this.setInitialDates();
        this.refreshAllViews();
        this.entryDate = DataUtils.getLocalIsoDate();
        this.expenseDate = DataUtils.getLocalIsoDate();
        
        // 🌟 Make the ESC listener global on load
        window.addEventListener('keydown', this._handleKeyDown);
    }

    disconnectedCallback() {
        window.removeEventListener('mousemove', this._onDrawMove);
        window.removeEventListener('mouseup', this._onDrawEnd);
        window.removeEventListener('mousemove', this._onResizeMove);
        window.removeEventListener('mouseup', this._onResizeEnd);
        window.removeEventListener('keydown', this._handleKeyDown);
    }

    setInitialDates() {
        const d = new Date();
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); 
        this.currentDate = new Date(d.setDate(diff));
        this.currentDate.setHours(0,0,0,0);
        this.viewedDate = new Date(this.currentDate);
    }

    @wire(getTimesheetData, { contactId: '$contactId' })
    wiredData(res) {
        this.wiredResult = res; 
        if (res.data) {
            try {
                this.allProjectResources = res.data.projectResources ? DataUtils.deepClone(res.data.projectResources) : [];
                this.allTimeEntries = res.data.timeEntries ? DataUtils.deepClone(res.data.timeEntries) : [];
                this.allProjectTasks = res.data.projectTasks ? DataUtils.deepClone(res.data.projectTasks) : [];
                this.allExpenses = res.data.expenses ? DataUtils.deepClone(res.data.expenses) : [];
                
                // Inside your @wire method:
                if (res.data.expenses) {
                    this.allRawExpenses = res.data.expenses.map(exp => {
                        const attachedFiles = exp.ContentDocumentLinks?.records || exp.ContentDocumentLinks;
                        const hasFile = attachedFiles && attachedFiles.length > 0;
                        
                        // Safely get filename with extension
                        let fName = '';
                        if (hasFile) {
                            fName = attachedFiles[0].ContentDocument.Title;
                            if (attachedFiles[0].ContentDocument.FileExtension) {
                                fName += '.' + attachedFiles[0].ContentDocument.FileExtension;
                            }
                        }

                        return {
                            Id: exp.Id,
                            projectId: exp.Project__c, // 🌟 THE FIX: Store the actual Project ID
                            amountValue: exp.Amount__c || 0,
                            displayAmount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(exp.Amount__c || 0),
                            dateValue: exp.Expense_Date__c,
                            displayDate: new Date(exp.Expense_Date__c).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                            projectName: exp.Project__r?.Name || 'General',
                            category: exp.Category__c || 'Uncategorized',
                            status: exp.Status__c || 'Draft',
                            notes: exp.Description__c || '',
                            hasReceipt: hasFile,
                            documentId: hasFile ? attachedFiles[0].ContentDocumentId : null, // 🌟 THE FIX: Grab correct ID
                            receiptName: fName,
                            masterItemClass: 'expense-item-card',
                            isActionRequired: exp.Status__c === 'Rejected',
                            pillClass: this.getPillClass(exp.Status__c)
                        };
                    });
                    if (!this.expFilterStartDate) this.setExpFilterMonth(); 
                    else this.processExpenseEngine();
                }
                
                if (res.data.contact) {
                    this.contactName = res.data.contact.Name || '';
                    this.contactTitle = res.data.contact.Title || res.data.contact.Department || '';
                }
                
                this._projectColorMap = {};
                DataUtils.uniqueBy(this.allProjectResources, r => r.Project__c).forEach((r, i) => {
                    if (r.Project__c && !this._projectColorMap[r.Project__c]) {
                        this._projectColorMap[r.Project__c] = this._colorPalette[i % this._colorPalette.length];
                    }
                });
                
                this.buildGrid();
            } catch (e) {
                console.error(e);
                this.showToast('Data Error', 'Failed to load data.', 'error');
            }
        } else if (res.error) {
            this.showToast('Load Error', res.error?.body?.message || 'Could not load timesheet.', 'error');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🧭 NAVIGATION & SYNC
    // ─────────────────────────────────────────────────────────────────────────
    get hasNotifications() { return this.unreadNotifications > 0; }
    openNotifications() { this.showToast('Notifications', 'You have pending approvals to review.', 'info'); }

    switchToTimesheet() { 
        this.activeTab = 'timesheet'; 
        this.clearExpenseState(); // Wipe state when leaving
    }

    handleLoadMore() {
        // Logic to fetch the next 20-50 records from Apex goes here.
        // For example: this.offset += 50; this.fetchExpenses();
        console.log('Lazy Loading triggered: Fetching next batch of expenses...');
    }

    // Global Keydown Listener for ESC
    _handleKeyDown = (event) => {
        if (event.key === 'Escape') {
            // Close File Preview if open
            if (this.isPreviewModalOpen) {
                this.closePreviewModal();
            }
            // Cancel Cut/Copy Paste mode if active
            if (this.copiedEntry) {
                this.clearClipboard();
                this.showToast('Cancelled', 'Action cancelled. Clipboard cleared.', 'info');
            }
        }
    };

    clearExpenseState() {
        this.selectedExpenseId = null;
        this.expenseProjectId = '';
        this.expenseDate = DataUtils.getLocalIsoDate();
        this.expenseAmount = '';
        this.expenseCategory = '';
        this.expenseDescription = '';
        this.expenseComments = '';
        this.expenseStatus = 'Draft';
        this.attachedFileName = '';
        this.attachedFileId = null;
        this.fileBase64 = null;
    }
    switchToExpenses() { 
        this.activeTab = 'expenses';
        this.clearExpenseState(); // Wipe state when returning
        if (this.allRawExpenses && this.allRawExpenses.length > 0) {
            this.processExpenseEngine();
        }
    }
    switchToWeekly() { 
        this.activeView = 'grid'; 
        this.refreshAllViews(); 
    }
   switchToList() { 
        this.activeView = 'list'; 
        if (!this.listTimeframe) this.listTimeframe = 'Weekly'; // Failsafe
        this.refreshAllViews(); 
    }

    handlePrevious() {
        const d = new Date(this.currentDate);
        d.setDate(d.getDate() - 7);
        this.currentDate = d;
        if (d.getMonth() !== this.viewedDate.getMonth()) this.viewedDate = new Date(d);
        this.refreshAllViews();
    }

    // 🌟 THE MISSING FUNCTION: Handles the List View timeframe dropdown
    handleTimeframeChange(event) {
        this.listTimeframe = event.target.value; // Now accepts native select value
        this.refreshAllViews();
    }

    // 🌟 SAAS SIDEBAR: Toggle Project Accordion
    toggleProjectExpand(event) {
        const projectId = event.currentTarget.dataset.id;
        if (this.expandedProjectIds.includes(projectId)) {
            this.expandedProjectIds = this.expandedProjectIds.filter(id => id !== projectId);
        } else {
            this.expandedProjectIds = [...this.expandedProjectIds, projectId];
        }
    }

    // 🌟 REPLACED: Handles both Selection and Expansion
    // handleProjectCardClick(event) {
    //     const projectId = event.currentTarget.dataset.id;
        
    //     // 1. Toggle Active Context (Select / Deselect)
    //     if (this.activeSidebarProjectId === projectId) {
    //         this.activeSidebarProjectId = null; // Deselect if already active
    //     } else {
    //         this.activeSidebarProjectId = projectId; // Set as new active project
    //     }
        
    //     // 2. Handle Expansion (Keeps the accordion functionality working)
    //     if (this.expandedProjectIds.includes(projectId)) {
    //         this.expandedProjectIds = this.expandedProjectIds.filter(id => id !== projectId);
    //     } else {
    //         this.expandedProjectIds = [...this.expandedProjectIds, projectId];
    //     }
    // }


    // ==========================================
    // 🌟 ZONE A: The Context Selector (Sets Default Project)
    // ==========================================
    handleProjectSelect(event) {
        const projectId = event.currentTarget.dataset.id;
        
        // Toggle selection logic
        if (this.activeSidebarProjectId === projectId) {
            this.activeSidebarProjectId = null; // Deselect if already active
        } else {
            this.activeSidebarProjectId = projectId; // Set as new default
        }
    }

    // ==========================================
    // 🌟 ZONE B: The Exploration Chevron (Expands Tasks)
    // ==========================================
    handleProjectExpand(event) {
        // 🛑 CRITICAL: Stops the click from accidentally triggering the selection zone!
        event.stopPropagation(); 
        
        const projectId = event.currentTarget.dataset.id;
        
        if (this.expandedProjectIds.includes(projectId)) {
            this.expandedProjectIds = this.expandedProjectIds.filter(id => id !== projectId);
        } else {
            this.expandedProjectIds = [...this.expandedProjectIds, projectId];
        }
    }

    // 🌟 UPGRADED SAAS SIDEBAR GETTER (Calculates Tasks & Hours)
    get sidebarProjects() {
        const up = DataUtils.uniqueBy(this.allProjectResources, r => r.Project__c);
        const f = up.filter(r => (r.Project__r?.Name || r.Name || '').toLowerCase().includes(this.searchTerm.toLowerCase()));
        
        return f.map(r => {
            const c = this._projectColorMap[r.Project__c] || this._colorPalette[0];
            
            // 1. Get all entries for THIS project in the CURRENT week
            const projectEntries = this.allTimeEntries.filter(e =>
                e.Project__c === r.Project__c && this.dateHeaders.length &&
                e.Date__c >= this.dateHeaders[0].dateValue && e.Date__c <= this.dateHeaders[this.dateHeaders.length - 1].dateValue
            );

            // 2. Calculate Total Week Hours for the Project
            const totalWeekHours = projectEntries.reduce((s, e) => s + (parseFloat(e.Hours_Worked_Number_Format__c) || 0), 0);
            
            // 3. Group the hours by Task
            const taskMap = {};
            projectEntries.forEach(e => {
                const taskId = e.Task__c || 'unassigned';
                if (!taskMap[taskId]) {
                    const taskObj = this.allProjectTasks.find(t => t.Id === taskId);
                    taskMap[taskId] = {
                        id: taskId,
                        name: taskObj ? taskObj.Name : 'General / Unassigned',
                        hours: 0
                    };
                }
                taskMap[taskId].hours += (parseFloat(e.Hours_Worked_Number_Format__c) || 0);
            });

            // 4. Convert map to array and sort by most hours worked
            const tasks = Object.values(taskMap)
                .filter(t => t.hours > 0) // Only show tasks that actually have time logged
                .map(t => ({ ...t, hoursFormatted: t.hours.toFixed(1) }))
                .sort((a, b) => b.hours - a.hours); 

            const fallbackCode = r.Project__c ? 'PRJ-' + r.Project__c.substring(11, 15).toUpperCase() : 'PRJ-001';
            const isExpanded = this.expandedProjectIds.includes(r.Project__c);
            const isActiveContext = this.activeSidebarProjectId === r.Project__c;

            return {
                id: r.Project__c,
                projectName: r.Project__r?.Name || r.Name,
                projectCode: r.Project__r?.ProjectCode__c || fallbackCode,
                weekHours: totalWeekHours.toFixed(1),
                cardStyle: `border-left-color: ${c.border};`,
                dotStyle: `background-color: ${c.dot};`,
                tasks: tasks,
                hasTasks: tasks.length > 0,
                isExpanded: isExpanded,
                chevronClass: isExpanded ? 'chevron-icon expanded' : 'chevron-icon',
                contentClass: isExpanded ? 'project-task-list expanded' : 'project-task-list',
                isActiveContext: isActiveContext,
                cardCssClass: isActiveContext ? 'saas-project-card active-context' : 'saas-project-card',
                cardStyle: isActiveContext ? '' : `border-left-color: ${c.border};`
            };
        });
    }

    handleNext() {
        const d = new Date(this.currentDate);
        d.setDate(d.getDate() + 7);
        this.currentDate = d;
        if (d.getMonth() !== this.viewedDate.getMonth()) this.viewedDate = new Date(d);
        this.refreshAllViews();
    }

    handleToday() {
        this.setInitialDates();
        this.refreshAllViews();
    }

    handleDatePick(e) {
        if (!e.target.value) return;
        const [y, m, d] = e.target.value.split('-');
        this.currentStartDate = new Date(y, m - 1, d, 0, 0, 0, 0);
        this.refreshAllViews();
    }

    refreshAllViews() {
        this.currentStartDate = new Date(this.currentDate); 
        this.generateDateHeaders();
        this.generateMiniCalendar();
        this.buildGrid();
    }

    // 🌟 UPGRADED MATRIX GETTER: Added try/catch and null-safety
    // 🌟 UPGRADED MATRIX GETTER (Supports Dynamic Array Sizing)
    // 🌟 BULLETPROOF MATRIX GETTER
    get matrixViewData() {
        try {
            if (!this.dateHeaders || this.dateHeaders.length === 0) return { rows: [], footer: [], grandTotal: '0.00' };
            
            // 🌟 CRITICAL FIX: Unwrap the proxy to guarantee fresh data
            const safeEntries = this.allTimeEntries ? JSON.parse(JSON.stringify(this.allTimeEntries)) : [];
            const safeResources = this.allProjectResources ? JSON.parse(JSON.stringify(this.allProjectResources)) : [];
            
            const projectMap = {}; 
            const dailyTotals = new Array(this.dateHeaders.length).fill(0);
            let grandTotal = 0;
            
            // 1. Pre-fill known projects
            safeResources.forEach(pr => {
                if (pr.Project__c && !projectMap[pr.Project__c]) {
                    projectMap[pr.Project__c] = { 
                        id: pr.Project__c, 
                        projectName: pr.Project__r?.Name || pr.Name || 'Unnamed Project', 
                        days: new Array(this.dateHeaders.length).fill(0), 
                        total: 0 
                    };
                }
            });
            
            const dateIndexMap = {};
            this.dateHeaders.forEach((dh, idx) => { dateIndexMap[dh.dateValue] = idx; });
            
            // 2. Map entries and calculate math
            safeEntries.forEach(entry => {
                const colIndex = dateIndexMap[entry.Date__c];
                if (colIndex !== undefined) {
                    
                    if (!projectMap[entry.Project__c]) {
                        projectMap[entry.Project__c] = {
                            id: entry.Project__c || 'unknown',
                            projectName: entry.Project__r?.Name || 'Other Project',
                            days: new Array(this.dateHeaders.length).fill(0),
                            total: 0
                        };
                    }
                    
                    let hours = parseFloat(entry.Hours_Worked_Number_Format__c);
                    if (isNaN(hours) || hours === 0) {
                        const sMins = TimeUtils.toMinutes(entry.Start_Time__c);
                        let eMins = TimeUtils.toMinutes(entry.End_Time__c);
                        if (eMins <= sMins) eMins += 1440; 
                        hours = (eMins - sMins) / 60;
                    }
                    hours = isNaN(hours) ? 0 : hours;

                    if (hours > 0) {
                        projectMap[entry.Project__c].days[colIndex] += hours;
                        projectMap[entry.Project__c].total += hours;
                        dailyTotals[colIndex] += hours;
                        grandTotal += hours;
                    }
                }
            });
            // 🌟 REMOVED THE FILTER: This forces all assigned projects to display permanently!
            const activeRows = Object.values(projectMap)
                .sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
        
            
            const formattedRows = activeRows.map(r => ({
                ...r,
                formattedTotal: r.total > 0 ? r.total.toFixed(2) : '-',
                formattedDays: r.days.map((d, i) => ({ 
                    key: `${r.id}-${i}`, 
                    value: d > 0 ? d.toFixed(2) : '-',
                    cellClass: d > 0 ? 'matrix-cell-day has-hours' : 'matrix-cell-day empty-hours'
                }))
            }));
            
            const formattedFooter = dailyTotals.map((d, i) => ({ key: `footer-${i}`, value: d > 0 ? d.toFixed(2) : '-' }));
            
            return { rows: formattedRows, footer: formattedFooter, grandTotal: grandTotal > 0 ? grandTotal.toFixed(2) : '0.00' };
            
        } catch (error) {
            console.error('Matrix View Error:', error);
            return { rows: [], footer: [], grandTotal: '0.00' };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 📅 MINI-CALENDAR ENGINE
    // ─────────────────────────────────────────────────────────────────────────
    generateMiniCalendar() {
        if (!this.viewedDate) this.viewedDate = new Date();
        const year = this.viewedDate.getFullYear();
        const month = this.viewedDate.getMonth();
        this.currentMonthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(this.viewedDate);

        const firstDay = new Date(year, month, 1);
        let start = new Date(firstDay);
        const dayIdx = start.getDay(); 
        start.setDate(start.getDate() - (dayIdx === 0 ? 6 : dayIdx - 1));

        const gridWeekStart = new Date(this.currentDate);
        const gridWeekEnd = new Date(this.currentDate);
        gridWeekEnd.setDate(gridWeekEnd.getDate() + 6);

        let weeks = [];
        let tempDate = new Date(start);
        
        for (let i = 0; i < 6; i++) {
            let week = { id: i, days: [], rowClass: 'mini-cal-week' };
            let weekIsActive = false;

            for (let j = 0; j < 7; j++) {
                const isToday = tempDate.toDateString() === new Date().toDateString();
                if (tempDate >= gridWeekStart && tempDate <= gridWeekEnd) weekIsActive = true;

                week.days.push({
                    id: tempDate.getTime(),
                    label: tempDate.getDate(),
                    className: `mini-cal-day ${tempDate.getMonth() !== month ? 'muted' : ''} ${isToday ? 'today' : ''}`,
                    dateValue: tempDate.toISOString()
                });
                tempDate.setDate(tempDate.getDate() + 1);
            }
            if (weekIsActive) week.rowClass += ' active-week';
            weeks.push(week);
        }
        this.miniCalendarWeeks = weeks;
    }

    handleMiniCalDayClick(event) {
        const clickedDate = new Date(event.currentTarget.dataset.date);
        const day = clickedDate.getDay();
        const diff = clickedDate.getDate() - day + (day === 0 ? -6 : 1);
        this.currentDate = new Date(clickedDate);
        this.currentDate.setDate(diff);
        this.currentDate.setHours(0,0,0,0);
        
        if (this.currentDate.getMonth() !== this.viewedDate.getMonth()) {
            this.viewedDate = new Date(this.currentDate);
        }
        this.refreshAllViews();
    }

    handleMiniCalPrevMonth() {
        this.viewedDate = new Date(this.viewedDate.setMonth(this.viewedDate.getMonth() - 1));
        this.generateMiniCalendar();
    }

    handleMiniCalNextMonth() {
        this.viewedDate = new Date(this.viewedDate.setMonth(this.viewedDate.getMonth() + 1));
        this.generateMiniCalendar();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🧠 EXPENSE PROCESSING ENGINE & FILTERS
    // ─────────────────────────────────────────────────────────────────────────
    get tabAllClass() { return this.activeStatusTab === 'All' ? 'saas-segment active' : 'saas-segment'; }
    get tabDraftClass() { return this.activeStatusTab === 'Draft' ? 'saas-segment active' : 'saas-segment'; }
    get tabSubmittedClass() { return this.activeStatusTab === 'Submitted' ? 'saas-segment active' : 'saas-segment'; }
    get tabApprovedClass() { return this.activeStatusTab === 'Approved' ? 'saas-segment active' : 'saas-segment'; }
    get tabInvoicedClass() { return this.currentTab === 'Invoiced' ? 'saas-tab active' : 'saas-tab'; }
    get tabRejectedClass()  { return this.activeStatusTab === 'Rejected'  ? 'active' : ''; }
// Add this to your Tab Class Getters
    get filterTodayVariant() { return this.expenseFilterType === 'today' ? 'brand' : 'neutral'; }
    get filterYesterdayVariant() { return this.expenseFilterType === 'yesterday' ? 'brand' : 'neutral'; }
    get filterWeekVariant() { return this.expenseFilterType === 'week' ? 'brand' : 'neutral'; }
    get filterMonthVariant() { return this.expenseFilterType === 'month' ? 'brand' : 'neutral'; }
    get isListWeekly() { return this.listTimeframe === 'Weekly'; }
    get isListMonthly() { return this.listTimeframe === 'Monthly'; }

    // 🌟 FILTER BAR PRESETS (Expense Tab)
    get presetTodayClass() { return this.activeDatePreset === 'Today' ? 'preset-btn active' : 'preset-btn'; }
    get presetYesterdayClass() { return this.activeDatePreset === 'Yesterday' ? 'preset-btn active' : 'preset-btn'; }
    get presetMonthClass() { return this.activeDatePreset === 'Month' ? 'preset-btn active' : 'preset-btn'; }

    get currentPeriodLabel() {
        if (this.isWeeklyView) return 'This Week';
        return this.isListWeekly ? 'This Week' : 'This Month';
    }

    get viewGridClass() { 
        return this.isWeeklyView ? 'saas-view-btn active' : 'saas-view-btn'; 
    }
    get viewListClass() { 
        return this.isListView ? 'saas-view-btn active' : 'saas-view-btn'; 
    }
    
    get listViewWeeklyClass() { return this.isListWeekly ? 'saas-tab active' : 'saas-tab'; }
    get listViewMonthlyClass() { return this.isListMonthly ? 'saas-tab active' : 'saas-tab'; }

    getLocalDateString(dateObj) { return new Date(dateObj.getTime() - (dateObj.getTimezoneOffset() * 60000)).toISOString().split('T')[0]; }


    handlePrevPeriod() { 
        if (this.isListView && this.isListMonthly) {
            // 🌟 Navigates back by 1 Full Month
            const d = new Date(this.currentDate);
            d.setMonth(d.getMonth() - 1);
            this.currentDate = d;
            this.refreshAllViews();
        } else {
            // Navigates back by 1 Week
            this.handlePrevious(); 
        }
    }

    handleNextPeriod() { 
        if (this.isListView && this.isListMonthly) {
            // 🌟 Navigates forward by 1 Full Month
            const d = new Date(this.currentDate);
            d.setMonth(d.getMonth() + 1);
            this.currentDate = d;
            this.refreshAllViews();
        } else {
            // Navigates forward by 1 Week
            this.handleNext(); 
        }
    }
    handleCurrentPeriod() { this.isWeeklyView ? this.handleToday() : this.handleToday(); }


    setListViewWeekly() { 
        this.listTimeframe = 'Weekly'; 
        this.refreshAllViews();
    }
    
    setListViewMonthly() { 
        this.listTimeframe = 'Monthly'; 
        this.refreshAllViews();
    }

    setExpFilterToday() {
        this.activeDatePreset = 'Today';
        this.expenseFilterType = 'today';
        const d = this.getLocalDateString(new Date());
        this.expFilterStartDate = d; this.expFilterEndDate = d;
        this.processExpenseEngine();
    }
    setExpFilterYesterday() {
        this.activeDatePreset = 'Yesterday';
        this.expenseFilterType = 'yesterday';
        let y = new Date(); y.setDate(y.getDate() - 1);
        const d = this.getLocalDateString(y);
        this.expFilterStartDate = d; this.expFilterEndDate = d;
        this.processExpenseEngine();
    }
    setExpFilterWeek() {
        this.expenseFilterType = 'week';
        let curr = new Date();
        let first = curr.getDate() - curr.getDay() + (curr.getDay() === 0 ? -6 : 1);
        this.expFilterStartDate = this.getLocalDateString(new Date(curr.setDate(first)));
        this.expFilterEndDate = this.getLocalDateString(new Date(curr.setDate(first + 6)));
        this.processExpenseEngine();
    }
    setExpFilterMonth() {
        this.activeDatePreset = 'Month';
        this.expenseFilterType = 'month';
        let curr = new Date();
        this.expFilterStartDate = this.getLocalDateString(new Date(curr.getFullYear(), curr.getMonth(), 1));
        this.expFilterEndDate = this.getLocalDateString(new Date(curr.getFullYear(), curr.getMonth() + 1, 0));
        this.processExpenseEngine();
    }

    handleExpStartDateChange(e) { this.expFilterStartDate = e.target.value; this.expenseFilterType = 'custom'; this.processExpenseEngine(); }
    handleExpEndDateChange(e) { this.expFilterEndDate = e.target.value; this.expenseFilterType = 'custom'; this.processExpenseEngine(); }
    handleStatusTabChange(e) { 
        this.currentExpPage = 1; // 🌟 Reset to page 1
        this.activeStatusTab = e.currentTarget.dataset.tab; 
        this.processExpenseEngine(); 
    }

    processExpenseEngine() {
        if (!this.allRawExpenses) return;

        // 1. DATE FILTERING
        const startStr = this.expFilterStartDate || '1900-01-01';
        const endStr = this.expFilterEndDate || '2099-12-31';
        const dateFiltered = this.allRawExpenses.filter(exp => exp.dateValue >= startStr && exp.dateValue <= endStr);

        // 2. KPI MATH & TAB COUNTS
        this.tabCounts = { all: 0, draft: 0, submitted: 0, approved: 0, rejected: 0, invoiced: 0 };
        let tApplied = 0, tDraft = 0, tSubmitted = 0, tApproved = 0, tRejected = 0, tInvoiced = 0;

        dateFiltered.forEach(exp => {
            this.tabCounts.all++;
            if (exp.status === 'Draft') this.tabCounts.draft++;
            if (exp.status === 'Submitted' || exp.status === 'Pending') this.tabCounts.submitted++;
            if (exp.status === 'Approved') this.tabCounts.approved++;
            if (exp.status === 'Rejected') this.tabCounts.rejected++;
            if (exp.status === 'Invoiced') this.tabCounts.invoiced++;

            tApplied += exp.amountValue;
            if (exp.status === 'Draft') tDraft += exp.amountValue;
            if (exp.status === 'Submitted' || exp.status === 'Pending') tSubmitted += exp.amountValue;
            if (exp.status === 'Approved') tApproved += exp.amountValue;
            if (exp.status === 'Rejected') tRejected += exp.amountValue;
            if (exp.status === 'Invoiced') tInvoiced += exp.amountValue;
        });

        const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
        this.kpiTotalApplied = formatter.format(tApplied);
        this.kpiTotalDraft = formatter.format(tDraft);
        this.kpiTotalPending = formatter.format(tSubmitted);
        this.kpiTotalApproved = formatter.format(tApproved);
        this.kpiTotalInvoiced = formatter.format(tInvoiced);

        // 3. TAB FILTERING & CSS FORMATTING
        this.displayExpenses = dateFiltered
            .filter(exp => {
                if (this.activeStatusTab === 'All') return true;
                if (this.activeStatusTab === 'Submitted') return exp.status === 'Submitted' || exp.status === 'Pending';
                return exp.status === this.activeStatusTab;
            })
            .map(exp => {
                // Dynamically applies the blue border to the clicked card
                return {
                    ...exp,
                    masterItemClass: this.selectedExpenseId === exp.Id ? 'expense-item-card active' : 'expense-item-card'
                };
            });
    }
    // ─────────────────────────────────────────────────────────────────────────
    // 📁 LIVE ATTACHMENT HANDLERS
    // ─────────────────────────────────────────────────────────────────────────
    handleUploadFinished(event) {
        if (event.detail.files.length > 0) {
            this.showToast('Success', 'Receipt attached securely.', 'success');
            refreshApex(this.wiredResult);
        }
    }
    
    async removeAttachment() {
        if (this.selectedExpenseId && this.attachedFileId) {
            try {
                // await deleteExpenseAttachment({ expenseId: this.selectedExpenseId });
                this.showToast('Deleted', 'File removed.', 'success');
            } catch (error) {
                console.error(error);
                this.showToast('Error', 'Failed to remove file.', 'error');
            }
        }
        this.attachedFileName = ''; 
        this.fileBase64 = null;
        this.attachedFileId = null;
        refreshApex(this.wiredResult);
    }

    // 🌟 BULLETPROOF FILE PREVIEW FOR SITES & GUEST USERS
    previewFile(event) {
        if (event) { event.stopPropagation(); event.preventDefault(); }

        if (this.fileBase64 && this.attachedFileName) {
            this._openLocalPreview();
            return;
        }

        if (!this.attachedFileId) {
            this.showToast('Error', 'No file found to preview.', 'error');
            return;
        }

        this.isPreviewModalOpen = true;
        this.isPreviewLoading = true;
        window.addEventListener('keydown', this._handleKeyDown); // Attach Listener

        getFilePreviewData({ documentId: this.attachedFileId })
            .then(result => {
                this.previewDataUrl = result.base64;
                this.previewFileType = result.fileType;
                this.previewFileName = result.title;
                this.isPreviewLoading = false;
            })
            .catch(err => {
                this.closePreviewModal();
                this.showToast('Preview Error', err.body?.message || 'Failed to load file.', 'error');
            });
    }

    closePreviewModal() {
        this.isPreviewModalOpen = false;
        this.previewDataUrl = '';
        this.previewFileType = '';
        window.removeEventListener('keydown', this._handleKeyDown); // Detach Listener
    }

    _openLocalPreview() {
        let ext = this.attachedFileName.split('.').pop().toLowerCase();
        let mime = 'image/jpeg';
        if (ext === 'png') mime = 'image/png';
        if (ext === 'pdf') mime = 'application/pdf';

        this.previewDataUrl = `data:${mime};base64,${this.fileBase64}`;
        this.previewFileType = ext;
        this.previewFileName = this.attachedFileName;
        this.isPreviewLoading = false;
        this.isPreviewModalOpen = true;
        window.addEventListener('keydown', this._handleKeyDown); // Attach Listener
    }

    downloadPreview() {
        if (!this.previewDataUrl) return;
        const a = document.createElement('a');
        a.href = this.previewDataUrl;
        a.download = this.previewFileName || 'Receipt_Download';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    get isPreviewImage() { return ['png', 'jpg', 'jpeg'].includes(this.previewFileType); }
    get isPreviewPdf() { return this.previewFileType === 'pdf'; }

    // ─────────────────────────────────────────────────────────────────────────
    // 🎛️ GENERAL GETTERS & HANDLERS
    // ─────────────────────────────────────────────────────────────────────────
    handleInputChange(event) {
        const fieldName = event.target.name;
        let fieldValue = event.detail && event.detail.value !== undefined ? event.detail.value : event.target.value;
        
        if (fieldName) { 
            this[fieldName] = fieldValue; 
            
            // 🌟 ENTERPRISE FORM STATE: Flag the form as changed
            this.isDirty = true; 
        }
    }
    
    getPillClass(status) {
        if (status === 'Draft') return 'saas-pill pill-neutral';
        if (status === 'Submitted' || status === 'Pending') return 'saas-pill pill-warning';
        if (status === 'Approved' || status === 'Invoiced') return 'saas-pill pill-success';
        if (status === 'Rejected') return 'saas-pill pill-danger';
        return 'saas-pill pill-neutral';
    }

    get isExpenseReadOnly() { return this.selectedExpenseId != null && this.expenseStatus !== 'Draft'; }
    get isTaskDisabled() { return !this.entryProjectId; }
    
    get timeframeOptions() { return [{ label: 'This Week', value: 'Weekly' }, { label: 'This Month', value: 'Monthly' }]; }
    
    get listRangeLabel() {
        if (this.listTimeframe === 'Monthly') {
            return this.currentStartDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        }
        return this.weekRangeLabel;
    }

    get isExpenseLocked() { return this.expenseStatus && this.expenseStatus !== 'Draft'; }
    get expenseLockBannerClass() {
        const status = this.expenseStatus;

        if (status === 'Rejected') {
            return 'saas-alert-banner alert-rejected';
        } else if (status === 'Submitted' || status === 'Pending') {
            return 'saas-alert-banner alert-submitted';
        } else if (status === 'Approved' || status === 'Invoiced') {
            return 'saas-alert-banner alert-approved';
        }
        
        return 'saas-alert-banner';
    }
    // 1. Determines the text message
    get expenseLockMessage() {
        // Assuming you track the selected expense's status in a variable called this.expenseStatus
        const status = this.expenseStatus; 

        if (status === 'Rejected') {
            return 'Please review manager comments and submit a new expense.';
        } else if (status === 'Submitted' || status === 'Pending') {
            return 'This expense is currently under review by finance.';
        } else if (status === 'Approved') {
            return 'This expense has been approved for payout.';
        } else if (status === 'Invoiced') {
            return 'This expense has been successfully processed and invoiced.';
        }
        
        // Fallback for any other locked state
        return 'This expense is locked and cannot be modified.';
    }

    // 3. Determines the specific SVG Icon
    get expenseLockIcon() {
        const status = this.expenseStatus;

        if (status === 'Rejected') {
            return 'utility:error'; // X icon
        } else if (status === 'Submitted' || status === 'Pending') {
            return 'utility:clock'; // Clock icon
        } else if (status === 'Approved' || status === 'Invoiced') {
            return 'utility:success'; // Checkmark icon
        }
        
        return 'utility:lock'; // Default lock icon
    }

    get isTimesheetTab() { return this.activeTab === 'timesheet'; }
    get isExpensesTab() { return this.activeTab === 'expenses'; }
    get timesheetTabClass() { return this.activeTab === 'timesheet' ? 'saas-main-tab active' : 'saas-main-tab'; }
    get expensesTabClass() { return this.activeTab === 'expenses' ? 'saas-main-tab active' : 'saas-main-tab'; }
    get isWeeklyView() { return this.activeView === 'grid'; }
    get isListView() { return this.activeView === 'list'; }
    get weeklyTabClass() { return `portal-tab ${this.activeView === 'weekly' ? 'tab-active' : ''}`; }
    get listTabClass() { return `portal-tab ${this.activeView === 'list' ? 'tab-active' : ''}`; }
    get weeklyButtonVariant() { return this.activeView === 'weekly' ? 'brand' : 'neutral'; }
    get listButtonVariant() { return this.activeView === 'list' ? 'brand' : 'neutral'; }

    get isFirstPage() { return this.currentPage <= 1; }
    get isLastPage() { return this.currentPage >= this.totalPages || this.totalPages === 0; }
    get pageIndicatorLabel() { return `Page ${this.currentPage} of ${this.totalPages || 1}`; }
    get paginationStart() { return this.totalRecords === 0 ? 0 : (this.currentPage - 1) * this.recordsPerPage + 1; }
    get paginationEnd() { return Math.min(this.currentPage * this.recordsPerPage, this.totalRecords); }
    
    get isEntryEdit() { return !!this.selectedEntryId; }
    get entryModalHeader() { return this.selectedEntryId ? 'Edit Time Entry' : 'Log Time'; }
    get isExpenseEdit() { return !!this.selectedExpenseId; }
    get hasSelectedEntries() { return this.selectedEntryIds.length > 0; }
    get selectedEntriesCount() { return this.selectedEntryIds.length; }
    
    get isEntryCopied() { return this.copiedEntry !== null; }
    get isCutActive() { return this.isCutAction && this.copiedEntry !== null; }
    // 🌟 CSS Getter for Paste Mode Crosshair Cursor
    get daysGridClass() { return this.isEntryCopied ? 'days-grid is-pasting' : 'days-grid'; }

    get timeSlots() {
        const s = [];
        for (let i = 0; i < 24; i++) {
            const l = i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`;
            s.push({ value: i, label: l, style: `top:${i * 60}px;`, gridStyle: `top:${i * 60}px;` });
        }
        return s;
    }
    get formattedCurrentDate() { return DataUtils.getLocalIsoDate(this.currentStartDate); }
    get weekRangeLabel() {
        if (!this.dateHeaders?.length) return '';
        const o = { month: 'short', day: 'numeric' };
        const f = new Date(this.dateHeaders[0].dateValue + 'T00:00:00');
        const l = new Date(this.dateHeaders[this.dateHeaders.length - 1].dateValue + 'T00:00:00');
        return `${f.toLocaleDateString('en-US', o)} – ${l.toLocaleDateString('en-US', { ...o, year: 'numeric' })}`;
    }
    
    get projectOptions() {
        return DataUtils.uniqueBy(this.allProjectResources, r => r.Project__c).map(r => ({
            label: r.Project__r?.Name || 'Unnamed Project',
            value: r.Project__c
        }));
    }
    get expenseProjectOptions() {
        if (!this.allProjectResources) return [];
        const uniqueProjects = [];
        const projectIds = new Set();
        this.allProjectResources.forEach(pr => {
            if (pr.Project__c && !projectIds.has(pr.Project__c)) {
                projectIds.add(pr.Project__c);
                uniqueProjects.push({ label: pr.Project__r.Name, value: pr.Project__c });
            }
        });
        return uniqueProjects;
    }

    // 🌟 SAAS MONTHLY BOARD GETTER (Structured by Weeks with Totals)
    get monthlyBoardView() {
        try {
            if (this.activeView !== 'list' || this.listTimeframe !== 'Monthly') return null;

            const year = this.currentStartDate.getFullYear();
            const month = this.currentStartDate.getMonth();
            const firstDay = new Date(year, month, 1);
            const startOffset = firstDay.getDay(); 
            const gridStart = new Date(firstDay);
            gridStart.setDate(firstDay.getDate() - startOffset);

            const todayIso = DataUtils.getLocalIsoDate(new Date());
            let grandTotal = 0;
            const weeks = [];
            let currentDate = new Date(gridStart);

            // Build 5 Weeks
            for (let w = 0; w < 5; w++) {
                const week = { id: `week-${w}`, days: [], weekTotal: 0 };

                // Build 7 Days per week
                for (let d = 0; d < 7; d++) {
                    const iso = DataUtils.getLocalIsoDate(currentDate);
                    const isCurrentMonth = currentDate.getMonth() === month;
                    const dayEntries = this.allTimeEntries ? this.allTimeEntries.filter(e => e.Date__c === iso) : [];
                    
                    let dayTotal = 0;
                    const projMap = {};

                    dayEntries.forEach(entry => {
                        let hours = parseFloat(entry.Hours_Worked_Number_Format__c);
                        if (isNaN(hours) || hours === 0) {
                            const sMins = TimeUtils.toMinutes(entry.Start_Time__c);
                            let eMins = TimeUtils.toMinutes(entry.End_Time__c);
                            if (eMins <= sMins) eMins += 1440; 
                            hours = (eMins - sMins) / 60;
                        }
                        hours = isNaN(hours) ? 0 : hours;

                        if (hours > 0) {
                            dayTotal += hours;
                            week.weekTotal += hours;
                            grandTotal += hours;
                            
                            if (!projMap[entry.Project__c]) {
                                const pr = this.allProjectResources.find(r => r.Project__c === entry.Project__c);
                                const colorPalette = this._projectColorMap[entry.Project__c] || { dot: '#9CA3AF', bg: '#F3F4F6', border: '#D1D5DB' };
                                projMap[entry.Project__c] = {
                                    id: entry.Project__c || 'unknown',
                                    name: pr?.Project__r?.Name || pr?.Name || 'Unnamed Project',
                                    hours: 0,
                                    pillStyle: `background: ${colorPalette.bg}; border: 1px solid ${colorPalette.border};`,
                                    dotStyle: `background: ${colorPalette.dot};`
                                };
                            }
                            projMap[entry.Project__c].hours += hours;
                        }
                    });

                    week.days.push({
                        id: iso,
                        dateNum: currentDate.getDate(),
                        cellClass: isCurrentMonth ? 'board-day-cell' : 'board-day-cell muted-day',
                        headerClass: iso === todayIso ? 'day-num today-num' : 'day-num',
                        totalFormatted: dayTotal > 0 ? `${dayTotal.toFixed(1)}h` : null,
                        projects: Object.values(projMap).map(p => ({ ...p, hoursFormatted: p.hours.toFixed(1) }))
                    });

                    currentDate.setDate(currentDate.getDate() + 1); // Move to next day
                }

                // Format Week Totals
                week.weekTotalFormatted = week.weekTotal > 0 ? `${week.weekTotal.toFixed(1)}h` : '-';
                week.weekTotalClass = week.weekTotal > 0 ? 'board-week-total has-hours' : 'board-week-total';
                weeks.push(week);
            }

            return {
                weeks: weeks,
                grandTotalFormatted: grandTotal > 0 ? `${grandTotal.toFixed(1)}h` : '0.0h'
            };

        } catch (error) {
            console.error('Monthly Board Error:', error);
            return null;
        }
    }

    get dynamicTaskOptions() {
        if (!this.entryProjectId) return [{ label: 'Select a project...', value: '' }];
        const filteredTasks = this.allProjectTasks.filter(t => t.Project__c === this.entryProjectId);
        if (filteredTasks.length === 0) return [{ label: 'No tasks found', value: '' }];
        return filteredTasks.map(t => ({ label: t.Name, value: t.Id }));
    }
    processExpenseEngine() {
        if (!this.allRawExpenses) return;

        // 1. DATE FILTERING
        const startStr = this.expFilterStartDate || '1900-01-01';
        const endStr = this.expFilterEndDate || '2099-12-31';
        const dateFiltered = this.allRawExpenses.filter(exp => exp.dateValue >= startStr && exp.dateValue <= endStr);

        // 2. KPI MATH & TAB COUNTS
        this.tabCounts = { all: 0, draft: 0, submitted: 0, approved: 0, rejected: 0, invoiced: 0 };
        let tApplied = 0, tDraft = 0, tSubmitted = 0, tApproved = 0, tRejected = 0, tInvoiced = 0;

        dateFiltered.forEach(exp => {
            this.tabCounts.all++;
            if (exp.status === 'Draft') this.tabCounts.draft++;
            if (exp.status === 'Submitted' || exp.status === 'Pending') this.tabCounts.submitted++;
            if (exp.status === 'Approved') this.tabCounts.approved++;
            if (exp.status === 'Rejected') this.tabCounts.rejected++;
            if (exp.status === 'Invoiced') this.tabCounts.invoiced++;

            tApplied += exp.amountValue;
            if (exp.status === 'Draft') tDraft += exp.amountValue;
            if (exp.status === 'Submitted' || exp.status === 'Pending') tSubmitted += exp.amountValue;
            if (exp.status === 'Approved') tApproved += exp.amountValue;
            if (exp.status === 'Rejected') tRejected += exp.amountValue;
            if (exp.status === 'Invoiced') tInvoiced += exp.amountValue;
        });

        const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
        this.kpiTotalApplied = formatter.format(tApplied);
        this.kpiTotalDraft = formatter.format(tDraft);
        this.kpiTotalPending = formatter.format(tSubmitted);
        this.kpiTotalApproved = formatter.format(tApproved);
        this.kpiTotalInvoiced = formatter.format(tInvoiced);

        // 3. TAB FILTERING & CSS FORMATTING
        this.displayExpenses = dateFiltered
            .filter(exp => {
                if (this.activeStatusTab === 'All') return true;
                if (this.activeStatusTab === 'Submitted') return exp.status === 'Submitted' || exp.status === 'Pending';
                return exp.status === this.activeStatusTab;
            })
            .map(exp => {
                // Maps the active highlight card CSS dynamically
                return {
                    ...exp,
                    masterItemClass: this.selectedExpenseId === exp.Id ? 'expense-item-card active' : 'expense-item-card'
                };
            });
    }

    get hasExpenses() { return this.processedExpenses.length > 0; }
    get masterContainerClass() { return this.selectedExpenseId ? 'split-view-master split-view-master-active' : 'split-view-master'; }
// ==========================================
    // 🎛️ DETAIL PANE HEADER & LOCK STATE
    // ==========================================

    // 1. Controls the Title (e.g., "Software License - Apr 20, 2026")
    get expenseDetailTitle() {
        if (!this.selectedExpenseId) return 'Expense Details';
        
        // 🌟 THE FIX: Intercept the new record state
        if (this.selectedExpenseId === 'NEW') {
            return 'Create New Expense'; 
        }
        
        const cat = this.expenseCategory || 'Uncategorized';
        const dte = this.expenseDate ? new Date(this.expenseDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        
        return dte ? `${cat} • ${dte}` : cat;
    }

    // 2. Controls the Monospace Tech Badge
    get expenseDetailSubtitle() {
        if (!this.selectedExpenseId) return '';
        return `REF: ${this.selectedExpenseId}`; 
    }

    // 3. 🌟 CRITICAL: Locks the form inputs so users can't edit approved data
    get isExpenseLocked() {
        const s = this.expenseStatus;
        // In enterprise SaaS, 'Rejected' usually unlocks the form so the user can fix it.
        // Submitted, Pending, Approved, and Invoiced are strictly locked.
        return s === 'Submitted' || s === 'Pending' || s === 'Approved' || s === 'Invoiced';
    }    
    get expenseDetailSubtitle() { return this.selectedExpenseId === 'NEW' ? 'Unsaved Record' : `ID: ${this.selectedExpenseId}`; }
    

    get expensesActionRequired() { return this.processedExpenses.filter(e => e.status === 'Rejected'); }
    get expensesDrafts() { return this.processedExpenses.filter(e => e.status === 'Draft'); }
    get expensesPending() { return this.processedExpenses.filter(e => e.status === 'Submitted' || e.status === 'Pending'); }
    get expensesCompleted() { return this.processedExpenses.filter(e => e.status === 'Invoiced'); }

    // ─────────────────────────────────────────────────────────────────────────
    // 🛠️ GRID BUILDER & MAPPERS
    // ─────────────────────────────────────────────────────────────────────────
    generateDateHeaders() {
        const h = [];
        const ts = DataUtils.getLocalIsoDate();
        let startDate = new Date(this.currentStartDate);
        let daysToGenerate = 7;

        // 🌟 DYNAMIC LOGIC: Weekly vs Monthly
        if (this.activeView === 'list' && this.listTimeframe === 'Monthly') {
            startDate = new Date(this.currentStartDate.getFullYear(), this.currentStartDate.getMonth(), 1);
            const nextMonth = new Date(this.currentStartDate.getFullYear(), this.currentStartDate.getMonth() + 1, 0);
            daysToGenerate = nextMonth.getDate(); // Will be 28, 29, 30, or 31
        } else {
            const day = startDate.getDay();
            const diff = startDate.getDate() - day + (day === 0 ? -6 : 1);
            startDate.setDate(diff);
        }

        for (let i = 0; i < daysToGenerate; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            const iso = DataUtils.getLocalIsoDate(d);
            
            // Format: '15' for Monthly, 'Mon 15' for Weekly
            let displayStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            if (this.activeView === 'list' && this.listTimeframe === 'Monthly') {
                displayStr = d.toLocaleDateString('en-US', { day: '2-digit' }); 
            }

            h.push({
                columnId: iso, dateValue: iso, display: displayStr,
                headerCellClass: iso === ts ? 'header-cell header-cell-today' : 'header-cell',
                todayLabelClass: iso === ts ? 'today-label' : '',
                isWeekend: d.getDay() === 0 || d.getDay() === 6
            });
        }
        this.dateHeaders = h;
    }

    buildGrid() {
        if (!this.allProjectResources?.length || !this.dateHeaders?.length) return;
        const todayStr = DataUtils.getLocalIsoDate();
        let weekTotalMs = 0;
        const searchTermStr = this.searchTerm.toLowerCase();
        const projectMap = DataUtils.buildProjectNameMap(this.allProjectResources);
        let visualBlocks = [];
        this.allTimeEntries.forEach(entry => {
            const sMins = TimeUtils.toMinutes(entry.Start_Time__c);
            const eMinsRaw = TimeUtils.toMinutes(entry.End_Time__c);
            if (entry.Start_Time__c && entry.End_Time__c && eMinsRaw <= sMins) {
                visualBlocks.push({ ...entry, visualDate: entry.Date__c, vStartMins: sMins, vEndMins: 1440, isOvernightPart: 'start', renderKey: entry.Id + '-start' });
                const nextDay = new Date(entry.Date__c + 'T00:00:00');
                nextDay.setDate(nextDay.getDate() + 1);
                visualBlocks.push({ ...entry, visualDate: DataUtils.getLocalIsoDate(nextDay), vStartMins: 0, vEndMins: eMinsRaw, isOvernightPart: 'end', renderKey: entry.Id + '-end' });
            } else {
                visualBlocks.push({ ...entry, visualDate: entry.Date__c, vStartMins: sMins, vEndMins: entry.End_Time__c ? eMinsRaw : (sMins + 60), isOvernightPart: false, renderKey: entry.Id });
            }
        });
        this.calendarColumns = this.dateHeaders.map(header => {
            let dayBlocks = visualBlocks.filter(vb => vb.visualDate === header.dateValue);
            if (searchTermStr) dayBlocks = dayBlocks.filter(vb => (projectMap[vb.Project__c] || '').toLowerCase().includes(searchTermStr));
            let clonedBlocks = DataUtils.deepClone(dayBlocks);
            clonedBlocks.sort((a, b) => a.vStartMins - b.vStartMins);
            clonedBlocks.forEach(b => b.isClashing = false);
            clonedBlocks.forEach((b1, idx) => {
                b1._level = 0;
                for (let i = 0; i < idx; i++) {
                    const b2 = clonedBlocks[i];
                    const isOverlapping = (b1.vStartMins < b2.vEndMins) && (b1.vEndMins > b2.vStartMins);
                    if (isOverlapping) {
                        b1.isClashing = true; b2.isClashing = true;
                        if (b1._level <= b2._level) b1._level = b2._level + 1;
                    }
                }
            });
            const mappedEntries = clonedBlocks.map(vb => {
                const pr = this.allProjectResources.find(r => r.Project__c === vb.Project__c);
                const color = this._projectColorMap[vb.Project__c] || this._colorPalette[0];
                return this._mapEntry(vb, pr, color);
            });
            const originalDayEntries = this.allTimeEntries.filter(e => e.Date__c === header.dateValue);
            const dayHrs = originalDayEntries.reduce((s, e) => s + (parseFloat(e.Hours_Worked_Number_Format__c) || 0), 0);
            weekTotalMs += dayHrs * 3600000;
            return { ...header, isPast: header.dateValue < todayStr, isDrawingGhost: this.activeGhostId === header.dateValue, entries: mappedEntries };
        });
        this.weeklyTotalHours = (weekTotalMs / 3600000).toFixed(1);
    }

    _mapEntry(vb, r, c) {
        const ss = this._statusShortMap[vb.Time_Status__c] || 'D';
        const sl = (vb.Time_Status__c || 'draft').toLowerCase();
        let css = `shift-box border-${sl}`;
        if (this.selectedEntryIds.includes(vb.Id)) css += ' selected-shift';
        if (this.isCutAction && this.cutEntryId === vb.Id) css += ' cut-pending';
        if (this.inlineEditEntryId === vb.Id) css += ' is-editing';
        const isStrictlyLocked = vb.Time_Status__c === 'Submitted' || vb.Time_Status__c === 'In Review' || vb.Time_Status__c === 'Approved';
        if (isStrictlyLocked) css += ' is-locked readonly-shift';
        if (vb.isOvernightPart === 'start') css += ' overnight-start';
        if (vb.isOvernightPart === 'end') css += ' overnight-end';
        const topPx = vb.vStartMins;
        const heightPx = Math.max(15, vb.vEndMins - vb.vStartMins);
        const shiftDurationHours = heightPx / 60;
        if (shiftDurationHours <= 1.5) css += ' short-shift';
        const h = parseFloat(vb.Hours_Worked_Number_Format__c) || 0;
        const tr = (vb.Start_Time__c && vb.End_Time__c) ? `${TimeUtils.formatTime12h(vb.Start_Time__c)} – ${TimeUtils.formatTime12h(vb.End_Time__c)}` : `${h.toFixed(1)}h`;
        let pc = 'status-pill pill-pending';
        if (vb.Time_Status__c === 'Approved') pc = 'pill-confirmed';
        else if (vb.Time_Status__c === 'Submitted') pc = 'pill-active';
        else if (vb.Time_Status__c === 'Rejected') pc = 'pill-rejected';
        const lp = 4 + (vb._level * 18);
        const zi = 3 + vb._level;
        if (vb.isClashing) css += ' clashing-shift';
        let taskName = 'Time Entry';
        if (vb.Task__c) { 
            const foundTask = this.allProjectTasks.find(t => t.Id === vb.Task__c);
            if (foundTask) taskName = foundTask.Name;
        }
        return {
            ...vb, id: vb.Id, isClashing: vb.isClashing, renderKey: vb.renderKey,
            description: vb.Additional_Comments__c || taskName,
            shortDesc: this._shortDesc(vb.Additional_Comments__c || taskName),
            timeRange: tr, hours: h.toFixed(1),
            displayDate: vb.Date__c ? new Date(vb.Date__c + 'T00:00:00').toLocaleDateString() : '',
            cssClass: css,
            dynamicStyle: `top:${topPx}px; height:${heightPx}px; left:${lp}px; z-index:${zi}; border-left-color: ${c.border};`,
            pillClass: pc, statusShort: ss, typeLabel: taskName,
            isEditable: !isStrictlyLocked, isLocked: isStrictlyLocked,
            
            // 🌟 THE DRAG FIX: Directly maps HTML5 draggable attribute
            draggableAttr: !isStrictlyLocked ? 'true' : 'false',
            
            btnCutClass: isStrictlyLocked ? 'btn-disabled' : 'action-btn btn-cut',
            btnDeleteClass: isStrictlyLocked ? 'btn-disabled' : 'action-btn btn-delete',
            isCutPending: this.isCutAction && this.cutEntryId === vb.Id,
            isSelected: this.selectedEntryIds.includes(vb.Id),
            projectName: r?.Project__r?.Name || '—',
            colorDot: `background:${c.dot};`,
            showResizeTop: !isStrictlyLocked && vb.isOvernightPart !== 'end',
            showResizeBottom: !isStrictlyLocked && vb.isOvernightPart !== 'start'
        };
    }
    _shortDesc(t) { if (!t) return ''; const w = t.trim().split(/\s+/); return w.length <= 3 ? t : w.slice(0, 3).join(' ') + '…'; }

    // ─────────────────────────────────────────────────────────────────────────
    // 🖱️ TIMESHEET MODALS & CREATION
    // ─────────────────────────────────────────────────────────────────────────
    openNewTimeEntry() { this._openEntryModal(null, this.formattedCurrentDate, null); }
    get durationOptions() {
        return [
            { label: 'Custom / Manual', value: '' },
            { label: '15 mins', value: '15' }, { label: '30 mins', value: '30' },
            { label: '45 mins', value: '45' }, { label: '1 hr', value: '60' },
            { label: '1.5 hrs', value: '90' }, { label: '2 hrs', value: '120' },
            { label: '3 hrs', value: '180' }, { label: '4 hrs', value: '240' },
            { label: '8 hrs', value: '480' }
        ];
    }
    _addMinutesToTime(timeStr, addMins) {
        if (!timeStr) return null;
        let [h, m] = timeStr.split(':').map(Number);
        let totalMins = h * 60 + m + parseInt(addMins, 10);
        let newH = Math.floor(totalMins / 60) % 24;
        let newM = totalMins % 60;
        return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
    }
    _getDiffInMinutes(startStr, endStr) {
        if (!startStr || !endStr) return 0;
        let [sh, sm] = startStr.split(':').map(Number);
        let [eh, em] = endStr.split(':').map(Number);
        let diff = (eh * 60 + em) - (sh * 60 + sm);
        if (diff < 0) diff += 1440;
        return diff;
    }
    handleStartTimeChange(e) {
        this.entryStartTime = e.detail.value;
        if (this.entryDuration) this.entryEndTime = this._addMinutesToTime(this.entryStartTime, this.entryDuration);
        else this._syncDurationFromTimes();
    }
    handleDurationChange(e) {
        this.entryDuration = e.detail.value;
        if (this.entryDuration && this.entryStartTime) this.entryEndTime = this._addMinutesToTime(this.entryStartTime, this.entryDuration);
    }
    handleEndTimeChange(e) {
        this.entryEndTime = e.detail.value;
        this._syncDurationFromTimes();
    }
    _syncDurationFromTimes() {
        if (this.entryStartTime && this.entryEndTime) {
            const diff = String(this._getDiffInMinutes(this.entryStartTime, this.entryEndTime));
            const matchesOption = this.durationOptions.some(opt => opt.value === diff);
            this.entryDuration = matchesOption ? diff : '';
        }
    }
    handleEntryProjectChange(e) { this.entryProjectId = e.detail.value; }

    handleCardDoubleClick(e) {
        if (e.target.closest('.shift-action-bar') || e.target.classList.contains('resize-handle')) return;
        const eid = e.currentTarget.dataset.id, en = this.allTimeEntries.find(x => x.Id === eid);
        if (!en) return;
        if (en.Time_Status__c === 'Submitted' || en.Time_Status__c === 'In Review' || en.Time_Status__c === 'Approved') {
            this.showToast('Locked', 'This entry is under review and cannot be edited.', 'info');
            return; 
        }
        this.selectedEntryId = en.Id;
        this.entryDate = en.Date__c;
        this.entryProjectId = en.Project__c;
        this.entryTaskId = en.Task__c || '';
        this.entryStartTime = TimeUtils.normalizeTime(en.Start_Time__c) || '09:00';
        this._syncDurationFromTimes();
        this.entryEndTime = TimeUtils.normalizeTime(en.End_Time__c) || '17:00';
        this._syncDurationFromTimes();
        this.entryBreakTime = en.Break_Time__c || 0;
        this.entryComments = en.Additional_Comments__c || '';
        this.isEntryModalOpen = true;
    }
    _openEntryModal(eid, date, pid) {
        this.selectedEntryId = eid;
        this.entryDate = date;
        this.entryProjectId = pid || '';
        this.entryTaskId = '';
        this.entryProjectId = pid || this.activeSidebarProjectId || '';
        if (!this.entryStartTime) this.entryStartTime = '09:00';
        if (!this.entryEndTime) this.entryEndTime = '17:00';
        this.entryBreakTime = 0;
        this.entryComments = '';
        this.isEntryModalOpen = true;
    }
    closeEntryModal() { this.isEntryModalOpen = false; }
    
    // 🌟 NULL LOOKUP FIX
    saveEntryModal() {
        if (!DataUtils.isValidSfId(this.contactId)) { this.showToast('Error', 'Contact ID missing.', 'error'); return; }
        if (!this.entryProjectId) { this.showToast('Required', 'Select a project.', 'warning'); return; }
        if (!this.entryDate || !this.entryStartTime || !this.entryEndTime) { this.showToast('Required', 'Fill date/time.', 'warning'); return; }
        const [sH, sM] = this.entryStartTime.split(':').map(Number), [eH, eM] = this.entryEndTime.split(':').map(Number);
        if (eH === sH && eM === sM) { this.showToast('Invalid', 'Start/End cannot be equal.', 'error'); return; }
        const pr = this.allProjectResources.find(r => r.Project__c === this.entryProjectId);
        if (!pr) { this.showToast('Error', 'Project not found.', 'error'); return; }
        
        saveTimeEntry({
            contactId: this.contactId, 
            projectResourceId: pr.Id, 
            projectId: this.entryProjectId,
            taskId: this.entryTaskId ? this.entryTaskId : null, // 🌟 Safe Null
            entryDate: this.entryDate,
            startHour: sH, startMinute: sM, endHour: eH, endMinute: eM,
            breakTime: parseFloat(this.entryBreakTime) || 0, 
            comments: this.entryComments || '', 
            existingId: this.selectedEntryId ? this.selectedEntryId : null
        }).then(() => {
            this.showToast('Saved', 'Time entry saved.', 'success');
            this.isEntryModalOpen = false;
            return refreshApex(this.wiredResult);
        }).catch(err => this.showToast('Error', err?.body?.message || err?.message || 'Save failed', 'error'));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🖱️ DRAG TO CREATE
    // ─────────────────────────────────────────────────────────────────────────
    handleCreateDragStart(e) {
        if (this.isWeekLocked) { this.showToast('Timesheet Locked', 'This week is under review.', 'warning'); return; }
        if (this.copiedEntry) return; // Prevent drawing if pasting!
        if (e.target.closest('.shift-box')) return;
        e.preventDefault();
        this._isDrawing = true;
        this._drawStartY = e.clientY;
        this._drawStartCell = e.currentTarget;
        const rect = e.currentTarget.getBoundingClientRect(), off = e.clientY - rect.top;
        this._dragStartMins = Math.round(off / 15) * 15;
        this.activeGhostId = e.currentTarget.dataset.date;
        this.ghostStyle = `top:${this._dragStartMins}px;height:15px;left:4px;right:4px;`;
        this.buildGrid();
        window.addEventListener('mousemove', this._onDrawMove, { passive: false });
        window.addEventListener('mouseup', this._onDrawEnd);
    }
    _onDrawMove = (e) => {
        if (!this._isDrawing) return;
        e.preventDefault();
        const dy = e.clientY - this._drawStartY, h = Math.max(15, Math.round(dy / 15) * 15);
        this.ghostStyle = `top:${this._dragStartMins}px;height:${h}px;left:4px;right:4px;`;
    };
    _onDrawEnd = () => {
        if (!this._isDrawing) return;
        this._isDrawing = false;
        window.removeEventListener('mousemove', this._onDrawMove);
        window.removeEventListener('mouseup', this._onDrawEnd);
        const mh = this.ghostStyle.match(/height:(\d+)px/), fh = mh ? parseInt(mh[1], 10) : 15;
        const endM = this._dragStartMins + fh, sh = Math.floor(this._dragStartMins / 60), sm = this._dragStartMins % 60, eh = Math.floor(endM / 60) % 24, em = endM % 60;
        this.entryStartTime = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
        this.entryEndTime = `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
        this.activeGhostId = null;
        this.buildGrid();
        this._openEntryModal(null, this._drawStartCell.dataset.date, null);
    };
    handleDragMouseUp() { if (this._isDrawing) { this._onDrawEnd(); } }

    // ─────────────────────────────────────────────────────────────────────────
    // 🖱️ DRAG TO MOVE
    // ─────────────────────────────────────────────────────────────────────────
    _dragCardOffsetY = 0;
    _draggedEntryId = null; // 🌟 Bypasses Locker Service data stripping
    
    handleDragStart(e) {
        if (e.currentTarget.dataset.editable !== 'true') { 
            e.preventDefault(); 
            return; 
        }
        
        const eid = e.currentTarget.dataset.id;
        if (!eid) return;

        this._draggedEntryId = eid; // Store in memory instead of dataTransfer
        const sn = this.allTimeEntries.find(x => x.Id === eid);
        const rect = e.currentTarget.getBoundingClientRect();
        this._dragCardOffsetY = e.clientY - rect.top;
        
        if (sn) this.pushToUndoStack('MOVE', { ...sn });
        
        // Keep this for browser compatibility, but we won't rely on it
        e.dataTransfer.setData('text/plain', eid);
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.classList.add('is-dragging');
    }
    
    handleDragOver(e) { e.preventDefault(); }
    handleDragEnd(e) { e.currentTarget.classList.remove('is-dragging'); this._draggedEntryId = null; }
    
    handleDrop(e) {
        if (this.isWeekLocked) return;
        e.preventDefault();
        
        // 🌟 Grab from memory first! This saves it on Sites.
        const eid = this._draggedEntryId || e.dataTransfer.getData('text/plain');
        const td = e.currentTarget.dataset.date;
        
        if (!eid || !td) return;

        const orig = this.allTimeEntries.find(x => x.Id === eid);
        if (!orig) return;
        
        const pr = this.allProjectResources.find(r => r.Project__c === orig.Project__c);
        if (!pr) { this.showToast('Error', 'Project not found.', 'error'); return; }
        
        const rect = e.currentTarget.getBoundingClientRect();
        const rawTopPx = (e.clientY - rect.top) - (this._dragCardOffsetY || 0);
        const dm = Math.max(0, Math.round(rawTopPx / 15) * 15);
        const sH = Math.floor(dm / 60); 
        const sM = dm % 60;

        // 🌟 SAVE TO UNDO HISTORY (Inserted right here!)
        this.actionHistory.push({
            type: 'MOVE',
            original: { ...orig }, // Saves original date & time before moving
            updated: {
                entryId: orig.Id,
                projectId: orig.Project__c,
                date: td,
                startHour: sH,
                startMinute: sM
            }
        });
        this.redoHistory = []; // Clear Redo whenever a new action occurs

        moveTimeEntry({
            entryId: eid, 
            newProjectResourceId: pr.Id, 
            newProjectId: orig.Project__c,
            newDate: td, 
            startHour: sH, 
            startMinute: sM
        }).then(() => {
            return refreshApex(this.wiredResult);
        }).catch(err => {
            this.showToast('Error', err.body?.message || 'Move failed.', 'error');
            this.actionHistory.pop(); // Revert history if the server fails
            this.isUndoDisabled = this.actionHistory.length === 0;
            return refreshApex(this.wiredResult);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🖱️ RESIZING
    // ─────────────────────────────────────────────────────────────────────────
    handleResizeStart(e) {
        e.stopPropagation(); e.preventDefault();
        this._isResizing = true;
        this._resizeStartY = e.clientY;
        this._resizingEntryId = e.target.dataset.id;
        this._resizeDirection = e.target.dataset.direction; 
        this._resizingEl = e.target.closest('.shift-box');
        const entry = this.allTimeEntries.find(x => x.Id === this._resizingEntryId);
        if (!entry) return;
        this._originalStartMins = TimeUtils.toMinutes(entry.Start_Time__c);
        this._originalEndMins = TimeUtils.toMinutes(entry.End_Time__c);
        this._originalTop = parseInt(this._resizingEl.style.top, 10) || this._originalStartMins;
        this._originalHeight = parseInt(this._resizingEl.style.height, 10) || (this._originalEndMins - this._originalStartMins);
        window.addEventListener('mousemove', this._onResizeMove, { passive: false });
        window.addEventListener('mouseup', this._onResizeEnd);
    }
    _onResizeMove = (e) => {
        if (!this._isResizing) return;
        e.preventDefault();
        const entry = this.allTimeEntries.find(x => x.Id === this._resizingEntryId);
        if (!entry) return;
        const dy = e.clientY - this._resizeStartY;
        const pixelsPerMinute = 1;
        let newStartMins = this._originalStartMins;
        let newEndMins = this._originalEndMins;
        if (this._resizeDirection === 'top') {
            let deltaMins = Math.round(dy / pixelsPerMinute);
            newStartMins = this._originalStartMins + deltaMins;
            newStartMins = Math.round(newStartMins / 15) * 15;
            const minStart = Math.max(0, this._originalEndMins - 1440); 
            const maxStart = this._originalEndMins - 15; 
            newStartMins = Math.max(minStart, Math.min(newStartMins, maxStart));
        } else {
            let deltaMins = Math.round(dy / pixelsPerMinute);
            newEndMins = this._originalEndMins + deltaMins;
            newEndMins = Math.round(newEndMins / 15) * 15;
            const minEnd = this._originalStartMins + 15;
            const maxEnd = this._originalStartMins + 1440; 
            newEndMins = Math.max(minEnd, Math.min(newEndMins, maxEnd));
        }
        const wouldOverlap = this.allTimeEntries.some(other => {
            if (other.Id === entry.Id || other.Date__c !== entry.Date__c) return false;
            const otherStart = TimeUtils.toMinutes(other.Start_Time__c);
            let otherEnd = TimeUtils.toMinutes(other.End_Time__c);
            if (otherEnd <= otherStart) otherEnd += 1440; 
            return Math.max(newStartMins, otherStart) < Math.min(newEndMins, otherEnd);
        });
        if (wouldOverlap) {
            this.resizeTooltip.text = '⚠️ Time Conflict';
            this.resizeTooltip.style = `left:${e.clientX+20}px;top:${e.clientY}px;color:#ea001e;`;
            return; 
        }
        if (this._resizeDirection === 'top') {
            const newTopPx = newStartMins;
            const newHeightPx = this._originalEndMins - newStartMins;
            this._resizingEl.style.top = `${newTopPx}px`;
            this._resizingEl.style.height = `${newHeightPx}px`;
            const newSH = Math.floor(newStartMins / 60) % 24, newSM = newStartMins % 60;
            this.resizeTooltip = { visible: true, text: `Start: ${String(newSH).padStart(2,'0')}:${String(newSM).padStart(2,'0')}`, style: `left:${e.clientX+20}px;top:${e.clientY}px;` };
        } else {
            const newHeightPx = newEndMins - this._originalStartMins;
            this._resizingEl.style.height = `${newHeightPx}px`;
            const newEH = Math.floor(newEndMins / 60) % 24, newEM = newEndMins % 60;
            this.resizeTooltip = { visible: true, text: `End: ${String(newEH).padStart(2,'0')}:${String(newEM).padStart(2,'0')}`, style: `left:${e.clientX+20}px;top:${e.clientY}px;` };
        }
    };
    _onResizeEnd = () => {
        if (!this._isResizing) return;
        this._isResizing = false;
        this.resizeTooltip = { visible: false, text: '', style: '' };
        window.removeEventListener('mousemove', this._onResizeMove);
        window.removeEventListener('mouseup', this._onResizeEnd);
        const entry = this.allTimeEntries.find(x => x.Id === this._resizingEntryId);
        if (!entry) { this.buildGrid(); return; }
        const finalTop = parseInt(this._resizingEl.style.top, 10);
        const finalHeight = parseInt(this._resizingEl.style.height, 10);
        const finalStartMins = this._resizeDirection === 'top' ? finalTop : this._originalStartMins;
        const finalEndMins = this._resizeDirection === 'bottom' ? finalTop + finalHeight : this._originalEndMins;
        const sH = Math.floor(finalStartMins / 60) % 24, sM = finalStartMins % 60;
        const eH = Math.floor(finalEndMins / 60) % 24, eM = finalEndMins % 60;
        const projectRes = this.allProjectResources.find(r => r.Project__c === entry.Project__c);
        if (!projectRes) { this.buildGrid(); return; }
        
        saveTimeEntry({
            contactId: this.contactId, 
            projectResourceId: projectRes.Id, 
            projectId: entry.Project__c,
            taskId: entry.Task__c ? entry.Task__c : null, // Null Check!
            entryDate: entry.Date__c,
            startHour: sH, startMinute: sM, endHour: eH, endMinute: eM,
            breakTime: entry.Break_Time__c || 0, 
            comments: entry.Additional_Comments__c || '', 
            existingId: entry.Id
        }).then(() => refreshApex(this.wiredResult)).catch(err => {
            this.showToast('Error', err.body?.message || 'Failed to save changes.', 'error');
            this._resizingEl.style.top = `${this._originalTop}px`;
            this._resizingEl.style.height = `${this._originalHeight}px`;
            this.buildGrid();
        });
    };

    // ─────────────────────────────────────────────────────────────────────────
    // ✂️ SEAMLESS CUT, COPY & CLICK-TO-PASTE
    // ─────────────────────────────────────────────────────────────────────────
    handleBtnCut(e) {
        e.stopPropagation();
        e.preventDefault();
        
        // 🌟 currentTarget guarantees we get the ID from the div, not the icon
        const entryId = e.currentTarget.dataset.id; 
        const en = this.allTimeEntries.find(x => x.Id === entryId);
        if (!en) return;
        
        this.copiedEntry = { ...en };
        this.isCutAction = true;
        this.cutEntryId = en.Id;
        this.buildGrid();
        this.showToast('Cut', 'Click ANYWHERE on a day column to paste.', 'info');
    }

    handleBtnCopy(e) {
        e.stopPropagation();
        const en = this.allTimeEntries.find(x => x.Id === e.currentTarget.dataset.id);
        if (!en) return;
        this.copiedEntry = { ...en };
        this.isCutAction = false;
        this.cutEntryId = null;
        this.buildGrid();
        this.showToast('Copied', 'Click anywhere on the calendar column to paste.', 'info');
    }
    // 🌟 UPDATED: Clears both single entry and full week clipboards
    clearClipboard() {
        this.copiedEntry = null;
        this.isCutAction = false;
        this.cutEntryId = null;
        this.copiedWeekEntries = null;
        this.copiedWeekStartDate = null;
        this.buildGrid();
    }

    // ==========================================
    // 📋 ENTERPRISE BULK WEEK COPY & PASTE
    // ==========================================
    handleCopyWeek() {
        if (!this.dateHeaders || !this.dateHeaders.length) return;
        const startStr = this.dateHeaders[0].dateValue;
        const endStr = this.dateHeaders[this.dateHeaders.length - 1].dateValue;

        // Grab all entries for the current week
        this.copiedWeekEntries = this.allTimeEntries.filter(e => e.Date__c >= startStr && e.Date__c <= endStr);
        this.copiedWeekStartDate = startStr;

        if(this.copiedWeekEntries.length === 0) {
            this.showToast('Empty Week', 'There are no entries to copy this week.', 'warning');
            return;
        }

        // Clear single entry clipboard to avoid UX confusion
        this.copiedEntry = null; 
        this.isCutAction = false;

        this.showToast('Week Copied', 'Navigate to another week and click Paste Week.', 'info');
    }

    handlePasteWeek() {
        if (!this.isWeekCopied || !this.dateHeaders.length) return;
        if (this.isWeekLocked) {
            this.showToast('Locked', 'Cannot paste into a locked week.', 'warning');
            return;
        }

        this.isSaving = true; // Lock UI to prevent double-clicks

        const currentStartStr = this.dateHeaders[0].dateValue;
        const sourceStart = new Date(this.copiedWeekStartDate + 'T00:00:00');
        const targetStart = new Date(currentStartStr + 'T00:00:00');

        // Calculate exactly how many days we moved forward or backward
        const dayOffset = Math.round((targetStart - sourceStart) / (1000 * 60 * 60 * 24));

        if (dayOffset === 0) {
            this.showToast('Warning', 'You cannot paste into the exact same week you copied from.', 'warning');
            this.isSaving = false;
            return;
        }

        // Build a massive array of promises to save all entries simultaneously 
        const promises = this.copiedWeekEntries.map(orig => {
            const pr = this.allProjectResources.find(r => r.Project__c === orig.Project__c);
            if (!pr) return Promise.resolve({ status: 'skipped' });

            // Shift the date by the exact offset amount
            const origDate = new Date(orig.Date__c + 'T00:00:00');
            origDate.setDate(origDate.getDate() + dayOffset);
            const newDateStr = DataUtils.getLocalIsoDate(origDate);

            // Calculate standard hours
            const sMins = TimeUtils.toMinutes(orig.Start_Time__c);
            const sH = Math.floor(sMins / 60), sM = sMins % 60;
            let eMins = TimeUtils.toMinutes(orig.End_Time__c);
            if (eMins <= sMins) eMins += 1440; // Overnight handler
            const eH = Math.floor(eMins / 60) % 24, eM = eMins % 60;

            // Fire Apex (Existing ID = null forces it to create a NEW clone)
            return saveTimeEntry({
                contactId: this.contactId,
                projectResourceId: pr.Id,
                projectId: orig.Project__c,
                taskId: orig.Task__c ? orig.Task__c : null,
                entryDate: newDateStr,
                startHour: sH, startMinute: sM, endHour: eH, endMinute: eM,
                breakTime: parseFloat(orig.Break_Time__c) || 0,
                comments: orig.Additional_Comments__c || '',
                existingId: null 
            });
        });

        // Resolve all promises concurrently
        Promise.allSettled(promises).then(results => {
            const successes = results.filter(r => r.status === 'fulfilled').length;
            this.showToast('Week Pasted', `Successfully pasted ${successes} entries.`, 'success');
            this.clearClipboard();
            this.isSaving = false;
            return refreshApex(this.wiredResult);
        });
    }

    // 🌟 SAAS FEATURE: QUICK DURATION PILLS
    setQuickDuration(event) {
        const addedMins = parseInt(event.currentTarget.dataset.mins, 10);
        if (!this.entryStartTime) {
            this.entryStartTime = '09:00'; // Default if empty
        }
        
        // Calculate new End Time
        this.entryEndTime = this._addMinutesToTime(this.entryStartTime, addedMins);
        
        // Sync the dropdown state just in case
        this._syncDurationFromTimes();
    }

    handleDayColumnClick(e) {
        if (!this.copiedEntry) return; 
        if (this.isWeekLocked) { this.showToast('Locked', 'Cannot paste into a locked week.', 'warning'); return; }
        
        const td = e.currentTarget.dataset.date;
        if (!td) return;

        const orig = this.copiedEntry;
        const wasCut = this.isCutAction;
        
        // If it was a CUT, clear clipboard. If COPY, keep it active for multi-paste!
        if (wasCut) {
            this.clearClipboard(); 
        }

        const pr = this.allProjectResources.find(r => r.Project__c === orig.Project__c);
        if (!pr) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const dm = Math.max(0, Math.round((e.clientY - rect.top) / 15) * 15);
        const sH = Math.floor(dm / 60), sM = dm % 60;

        if (wasCut) {
            moveTimeEntry({ 
                entryId: orig.Id, newProjectResourceId: pr.Id, newProjectId: orig.Project__c, 
                newDate: td, startHour: sH, startMinute: sM 
            }).then(() => refreshApex(this.wiredResult)).catch(err => this.showToast('Error', err.body?.message, 'error'));
        } else {
            const origStartMins = TimeUtils.toMinutes(orig.Start_Time__c);
            let origEndMins = TimeUtils.toMinutes(orig.End_Time__c);
            if (origEndMins <= origStartMins) origEndMins += 1440;
            const endM = dm + (origEndMins - origStartMins);

            saveTimeEntry({ 
                contactId: this.contactId, projectResourceId: pr.Id, projectId: orig.Project__c, 
                taskId: orig.Task__c || null, // 🌟 Safe Null
                entryDate: td, 
                startHour: sH, startMinute: sM, endHour: Math.floor(endM / 60) % 24, endMinute: endM % 60, 
                breakTime: parseFloat(orig.Break_Time__c) || 0, comments: orig.Additional_Comments__c || '', 
                existingId: null // 🌟 CRITICAL FIX: Apex rejects '' as an ID. It must be null.
            }).then(() => refreshApex(this.wiredResult)).catch(err => this.showToast('Error', err.body?.message, 'error'));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 📋 BULK EDIT & SELECTION
    // ─────────────────────────────────────────────────────────────────────────
    handleEntrySelection(e) {
        e.stopPropagation();
        const id = e.target.dataset.id;
        this.selectedEntryIds = e.target.checked ? [...this.selectedEntryIds, id] : this.selectedEntryIds.filter(x => x !== id);
        this.buildGrid();
    }
    clearSelection() { this.selectedEntryIds = []; this.buildGrid(); }
    openBulkModal() { this.bulkType = ''; this.isBulkModalOpen = true; }
    closeBulkModal() { this.isBulkModalOpen = false; }
    saveBulkEdit() {
        const ps = this.selectedEntryIds.map(id => {
            const en = this.allTimeEntries.find(x => x.Id === id);
            if (!en) return Promise.resolve({ status: 'skipped' });
            const sn = TimeUtils.normalizeTime(en.Start_Time__c), [sH, sM] = sn ? sn.split(':').map(Number) : [9, 0];
            const en2 = TimeUtils.normalizeTime(en.End_Time__c), [eH, eM] = en2 ? en2.split(':').map(Number) : [17, 0];
            const pr = this.allProjectResources.find(r => r.Project__c === en.Project__c);
            if (!pr) return Promise.resolve({ status: 'skipped' });
            return saveTimeEntry({ contactId: this.contactId, projectResourceId: pr.Id, projectId: en.Project__c, taskId: this.bulkType || en.Task__c, entryDate: en.Date__c, startHour: sH, startMinute: sM, endHour: eH, endMinute: eM, breakTime: en.Break_Time__c || 0, comments: en.Additional_Comments__c, existingId: id })
            .then(r => ({ status: 'fulfilled', id, r })).catch(err => ({ status: 'rejected', id, reason: err?.body?.message }));
        });
        Promise.allSettled(ps).then(res => {
            this.showToast('Bulk Edit Complete', 'Entries updated.', 'success');
            this.isBulkModalOpen = false;
            this.clearSelection();
            return refreshApex(this.wiredResult);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🛡️ SECURITY & WEEK LOCKING
    // ─────────────────────────────────────────────────────────────────────────
    get isWeekLocked() {
        if (!this.dateHeaders || !this.dateHeaders.length) return false;
        const startStr = this.dateHeaders[0].dateValue;
        const endStr = this.dateHeaders[this.dateHeaders.length - 1].dateValue;
        const weekEntries = this.allTimeEntries.filter(e => e.Date__c >= startStr && e.Date__c <= endStr);
        return weekEntries.length > 0 && weekEntries.some(e => 
            e.Time_Status__c === 'Submitted' || e.Time_Status__c === 'In Review' || e.Time_Status__c === 'Approved'
        );
    }
    get calendarContainerClass() { return this.isWeekLocked ? 'calendar-container locked-week-container' : 'calendar-container'; }
    get disableSubmitWeekBtn() { return this.isWeekLocked || this.weeklyTotalHours === '0.0'; }


    
    openSubmitReview() {
        const startStr = this.dateHeaders[0].dateValue;
        const endStr = this.dateHeaders[this.dateHeaders.length - 1].dateValue;
        const draftEntries = this.allTimeEntries.filter(e => 
            e.Date__c >= startStr && e.Date__c <= endStr && 
            (e.Time_Status__c === 'Draft' || e.Time_Status__c === 'Rejected')
        );
        if (draftEntries.length === 0) {
            this.showToast('Notice', 'No Draft or Rejected entries found to submit.', 'info');
            return;
        }
        let summaryMap = {};
        let totalHrs = 0;
        draftEntries.forEach(e => {
            let key = `${e.Project__c}_${e.Task__c}`;
            if (!summaryMap[key]) {
                const pr = this.allProjectResources.find(r => r.Project__c === e.Project__c);
                const tsk = this.allProjectTasks.find(t => t.Id === e.Task__c);
                summaryMap[key] = { id: key, projectName: pr?.Project__r?.Name || 'Unknown Project', taskName: tsk?.Name || 'Unassigned Task', hours: 0 };
            }
            let h = parseFloat(e.Hours_Worked_Number_Format__c) || 0;
            summaryMap[key].hours += h;
            totalHrs += h;
        });
        this.submitSummary = Object.values(summaryMap).map(s => ({ ...s, hours: s.hours.toFixed(2) }));
        this.submitTotalHours = totalHrs.toFixed(2);
        this.isAttested = false;
        this.isSubmitReviewOpen = true;
    }
    closeSubmitReview() { this.isSubmitReviewOpen = false; }
    handleAttestationChange(e) { this.isAttested = e.target.checked; }
    confirmSubmitWeek() {
        if (!this.isAttested) return;
        const weekStart = this.dateHeaders[0].dateValue;
        const weekEnd = this.dateHeaders[this.dateHeaders.length - 1].dateValue;
        submitWeek({ contactId: this.contactId, weekStart: weekStart, weekEnd: weekEnd })
        .then(count => {
            this.showToast('Success', `Timesheet Submitted. ${count} entries locked for review.`, 'success');
            this.isSubmitReviewOpen = false;
            return refreshApex(this.wiredResult);
        }).catch(err => { this.showToast('Error', err.body?.message || 'Submission failed.', 'error'); });
    }

    handleShiftMouseEnter(e) {
        const id = e.currentTarget.dataset.id;
        if (!id) return;
        this._hoverEntryId = id;
        if (this._hoverTimeout) clearTimeout(this._hoverTimeout);
        const rect = e.currentTarget.getBoundingClientRect();
        this._hoverTimeout = setTimeout(() => {
            if (this._hoverEntryId !== id) return;
            const en = this.allTimeEntries.find(x => x.Id === id);
            if (!en) return;
            const pr = this.allProjectResources.find(r => r.Project__c === en.Project__c);
            const c = this._projectColorMap[en.Project__c] || this._colorPalette[0];
            let l = rect.right + 12, t = rect.top;
            if (l + 290 > window.innerWidth - 8) l = rect.left - 290 - 12;
            if (t + 220 > window.innerHeight - 8) t = window.innerHeight - 220 - 8;
            const taskName = en.Task__r?.Name || 'Unassigned Task';
            this.hoverCard = {
                visible: true, style: `left:${Math.max(8, l)}px;top:${Math.max(8, t)}px;`,
                headerStyle: `background:${c.border};color:#fff;padding:10px 12px;`,
                description: en.Additional_Comments__c || taskName,
                timeRange: (en.Start_Time__c && en.End_Time__c) ? `${TimeUtils.formatTime12h(en.Start_Time__c)} – ${TimeUtils.formatTime12h(en.End_Time__c)}` : '—',
                hours: (parseFloat(en.Hours_Worked_Number_Format__c) || 0).toFixed(1),
                displayDate: en.Date__c ? new Date(en.Date__c + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '',
                projectName: pr?.Project__r?.Name || 'Unknown Project', taskType: taskName, 
                status: en.Time_Status__c || 'Draft',
                pillClass: en.Time_Status__c === 'Approved' ? 'pill-confirmed' : en.Time_Status__c === 'Submitted' ? 'pill-active' : 'pill-pending',
                notes: en.Additional_Comments__c ? en.Additional_Comments__c : 'No notes added.'
            };
        }, 750);
    }
    handleShiftMouseLeave() {
        this._hoverEntryId = null;
        if (this._hoverTimeout) clearTimeout(this._hoverTimeout);
        if (this.hoverCard.visible) this.hoverCard = { ...this.hoverCard, visible: false };
    }
    
// Pushes the original state of the record to memory before a drag happens
    pushToUndoStack(type, rec) { 
        this.actionHistory.push({ type, record: { ...rec } }); 
        this.isUndoDisabled = false; 
    } 
    
    // handleUndo() {
    //     if (this.actionHistory.length === 0) return;
        
    //     const lastAction = this.actionHistory.pop();
    //     this.isUndoDisabled = this.actionHistory.length === 0;

    //     if (lastAction.type === 'MOVE') {
    //         const orig = lastAction.record;
    //         const pr = this.allProjectResources.find(r => r.Project__c === orig.Project__c);
            
    //         if (!pr) return;

    //         const sMins = TimeUtils.toMinutes(orig.Start_Time__c);
    //         const sH = Math.floor(sMins / 60);
    //         const sM = sMins % 60;

    //         // Silently move it back to its original day and time
    //         moveTimeEntry({
    //             entryId: orig.Id,
    //             newProjectResourceId: pr.Id,
    //             newProjectId: orig.Project__c,
    //             newDate: orig.Date__c,
    //             startHour: sH,
    //             startMinute: sM
    //         }).then(() => {
    //             this.showToast('Undo Successful', 'Time entry restored to its previous position.', 'success');
    //             return refreshApex(this.wiredResult);
    //         }).catch(err => {
    //             this.showToast('Undo Failed', err.body?.message || 'Could not revert entry.', 'error');
    //         });
    //     }
    // }

    handleUndo() {
        if (this.actionHistory.length === 0) return;
        
        const lastAction = this.actionHistory.pop();
        this.redoHistory.push(lastAction);

        if (lastAction.type === 'MOVE') {
            const orig = lastAction.original;
            const pr = this.allProjectResources.find(r => r.Project__c === orig.Project__c);
            if (!pr) return;

            const sMins = TimeUtils.toMinutes(orig.Start_Time__c);
            const sH = Math.floor(sMins / 60);
            const sM = sMins % 60;

            moveTimeEntry({
                entryId: orig.Id,
                newProjectResourceId: pr.Id,
                newProjectId: orig.Project__c,
                newDate: orig.Date__c,
                startHour: sH,
                startMinute: sM
            }).then(() => {
                this.showToast('Undo', 'Action reverted.', 'success');
                return refreshApex(this.wiredResult);
            });
        }
    }

    handleRedo() {
        if (this.redoHistory.length === 0) return;
        
        const nextAction = this.redoHistory.pop();
        this.actionHistory.push(nextAction);

        if (nextAction.type === 'MOVE') {
            const updated = nextAction.updated;
            const pr = this.allProjectResources.find(r => r.Project__c === updated.projectId);
            if (!pr) return;

            moveTimeEntry({
                entryId: updated.entryId,
                newProjectResourceId: pr.Id,
                newProjectId: updated.projectId,
                newDate: updated.date,
                startHour: updated.startHour,
                startMinute: updated.startMinute
            }).then(() => {
                this.showToast('Redo', 'Action reapplied.', 'success');
                return refreshApex(this.wiredResult);
            });
        }
    }

    handleBtnDelete(e) { 
        e.stopPropagation(); 
        e.preventDefault();
        
        const targetId = e.currentTarget.dataset.id;
        if (!targetId) return;
        
        this.pendingDeleteId = targetId; 
        this.deleteType = 'entry'; 
        this.isDeleteConfirmOpen = true; 
    }
    
    cancelDelete() { 
        this.showDeleteModal = false; 
        this.isDeleteConfirmOpen = false;
        this.pendingDeleteId = null;
    }
    confirmDelete() {
        // 🌟 1. Handle Expense Deletion
        if (this.showDeleteModal && this.selectedExpenseId) {
            this.showDeleteModal = false; 
            deleteExpense({ expenseId: this.selectedExpenseId })
                .then(() => { 
                    this.showToast('Deleted', 'Draft expense removed.', 'success'); 
                    this.selectedExpenseId = null; 
                    return refreshApex(this.wiredResult); 
                })
                .catch(err => this.showToast('Error', err.body?.message || 'Failed to delete.', 'error'));
            return;
        }

        // 🌟 2. Handle Time Entry Deletion
        if (this.isDeleteConfirmOpen && this.pendingDeleteId) {
            this.isDeleteConfirmOpen = false;
            
            // Note: Ensure 'deleteTimeEntry' is imported from Apex at the top of your file!
            deleteTimeEntry({ entryId: this.pendingDeleteId })
                .then(() => { 
                    this.showToast('Deleted', 'Time entry removed.', 'success'); 
                    this.pendingDeleteId = null;
                    this.clearSelection();
                    return refreshApex(this.wiredResult); 
                })
                .catch(err => this.showToast('Error', err.body?.message || 'Failed to delete.', 'error'));
        }
    }
    // ─────────────────────────────────────────────────────────────────────────
    // 💰 EXPENSE MODALS & ACTIONS
    // ─────────────────────────────────────────────────────────────────────────
    @wire(getObjectInfo, { objectApiName: EXPENSE_OBJECT })
    expenseObjectInfo({ data, error }) {
        if (data) this.expenseRecordTypeId = data.defaultRecordTypeId;
    }
    @wire(getPicklistValues, { recordTypeId: '$expenseRecordTypeId', fieldApiName: CATEGORY_FIELD })
    categoryPicklistValues({ data, error }) {
        if (data) this.expenseCategoryOptions = data.values.map(v => ({ label: v.label, value: v.value }));
        else if (error) this.expenseCategoryOptions = [{ label: 'Error loading categories', value: '' }];
    }

    handleSelectExpense(e) {
        this.isDirty = false;
        const expId = e.currentTarget.dataset.id;
        const exp = this.allRawExpenses.find(x => x.Id === expId) || this.allExpenses.find(x => x.Id === expId);
        if (exp) {
            this.selectedExpenseId = exp.Id;
            this.expenseProjectId = exp.projectId;
            this.expenseDate = exp.Expense_Date__c || exp.dateValue;
            this.expenseAmount = exp.Amount__c != null ? String(exp.Amount__c) : (exp.amountValue != null ? String(exp.amountValue) : '');
            this.expenseCategory = exp.Category__c || exp.category || '';
            this.expenseDescription = exp.Description__c || exp.notes || '';
            this.expenseComments = exp.Comments__c || '';
            let s = exp.Status__c || exp.status || 'Draft';
            this.expenseStatus = s === 'Open' ? 'Draft' : s; 
            if (exp.ContentDocumentLinks && (exp.ContentDocumentLinks.records || exp.ContentDocumentLinks).length > 0) {
                const links = exp.ContentDocumentLinks.records || exp.ContentDocumentLinks;
                const link = links[0];
                const doc = link.ContentDocument;
                this.attachedFileName = doc.Title + (doc.FileExtension ? '.' + doc.FileExtension : '');
                this.attachedFileId = link.ContentDocumentId;
            } else if (exp.hasReceipt) {
                this.attachedFileName = exp.receiptName || '';
                this.attachedFileId = exp.documentId;
            } else {
                this.attachedFileName = ''; this.attachedFileId = null;
            }
            this.fileBase64 = null; 
            
            // 🌟 THE FIX: Re-run the engine so the Active UI highlight updates
            this.processExpenseEngine();
        }
    }

    openAddExpense() {
        this.selectedExpenseId = 'NEW';
        this.expenseProjectId = '';
        this.expenseDate = DataUtils.getLocalIsoDate();
        this.expenseAmount = '';
        this.expenseCategory = '';
        this.expenseDescription = '';
        this.expenseComments = '';
        this.expenseStatus = 'Draft'; 
        this.attachedFileName = ''; 
        this.fileBase64 = null;
        this.attachedFileId = null;
    }

    // ==========================================
    // 🧮 PAGINATION & FORM STATE VARIABLES
    // ==========================================
    @track isSaving = false; // Prevents double-clicking the save button

    // ==========================================
    // 🌟 PAGINATION GETTERS & LOGIC
    // ==========================================


    closeExpenseModal() { this.isExpenseModalOpen = false; this.removeAttachmentLocalOnly(); }
    handleSaveDraft() { this.executeExpenseSave('Draft'); }
    handleSubmitExpense() {
        if (!this.expenseProjectId || !this.expenseDate || !this.expenseAmount) {
            this.showToast('Required Fields Missing', 'Please fill Project, Date, and Amount.', 'warning');
            return;
        }
        if (!this.attachedFileId && !this.fileBase64) this.isMissingReceiptModalOpen = true;
        else this.executeExpenseSave('Submitted');
    }
    confirmSubmitWithoutReceipt() { this.isMissingReceiptModalOpen = false; this.executeExpenseSave('Submitted'); }
    cancelSubmit() { this.isMissingReceiptModalOpen = false; }
    executeExpenseSave(targetStatus) {
        // 🌟 1. THE CONCURRENCY LOCK: Kills double-clicks instantly
        if (this.isSaving) return; 

        // Validation
        if (!this.expenseProjectId || !this.expenseAmount || this.expenseAmount <= 0) {
            this.showToast('Validation Error', 'Please select a Project and enter a valid amount.', 'error'); 
            return;
        }

        // 🌟 2. ENGAGE THE LOCK
        this.isSaving = true; 
        this.expenseStatus = targetStatus; 

        saveExpense({
            contactId: this.contactId, 
            projectId: this.expenseProjectId, 
            expenseDate: this.expenseDate,
            amount: parseFloat(this.expenseAmount), 
            category: this.expenseCategory,
            description: this.expenseDescription, 
            comments: this.expenseComments,
            existingId: this.selectedExpenseId === 'NEW' ? null : this.selectedExpenseId, 
            fileName: this.attachedFileName, 
            base64Data: this.fileBase64, 
            status: targetStatus 
        })
        .then(newId => {
            this.showToast('Success', `Expense ${targetStatus === 'Draft' ? 'saved as draft' : 'submitted for approval'}.`, 'success');
            
            // 🌟 1. BIND THE NEW ID
            this.selectedExpenseId = newId; 
            this.isDirty = false;
            
            // 🚨 DELETED: this.attachedFileName = ''; (Let the name stay on screen!)
            
            // 🌟 2. CLEAR HEAVY DATA: Only clear the base64 string so we don't upload it twice
            this.fileBase64 = null;
            
            // 🌟 3. REFRESH SERVER DATA
            return refreshApex(this.wiredResult);
        })
        .catch(err => {
            this.expenseStatus = 'Draft'; // Revert status on failure
            this.showToast('Error', err.body?.message || err.message || 'Save failed.', 'error');
        })
        .finally(() => {
            // 🌟 4. RELEASE THE LOCK: Always runs, whether success or fail
            this.isSaving = false; 
        });
    }

    handleDeleteDraft() {
        // 🌟 1. NO MORE confirm()! Just open our beautiful custom modal
        this.showDeleteModal = true; 
    }

    // 🌟 CANCEL FORM HANDLER
    handleCancelForm() {
        // 1. Clears all the input fields and sets selectedExpenseId to null
        this.clearExpenseState(); 
        
        // 2. Re-runs the display logic so the blue 'active' highlight 
        // is removed from the card in the master list
        if (this.allRawExpenses && this.allRawExpenses.length > 0) {
            this.processExpenseEngine();
        }
    }

    handleFileChange(event) {
        this.isDirty = true;
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 3000000) { this.showToast('File Too Large', 'Please select a file smaller than 3MB.', 'error'); return; }
        this.attachedFileName = file.name;
        const reader = new FileReader();
        reader.onload = () => { this.fileBase64 = reader.result.split(',')[1]; };
        reader.readAsDataURL(file);
    }
    removeAttachmentLocalOnly() { this.attachedFileName = ''; this.fileBase64 = null; }
    showToast(t, m, v) { this.dispatchEvent(new ShowToastEvent({ title: t, message: m, variant: v })); }
    stopPropagation(e) { e.stopPropagation(); }
    preventDrag(e) { e.preventDefault(); e.stopPropagation(); }
}