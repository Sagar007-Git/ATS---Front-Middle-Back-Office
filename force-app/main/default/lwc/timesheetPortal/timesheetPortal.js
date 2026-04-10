import { LightningElement, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';
import getTimesheetData from '@salesforce/apex/TimesheetPortalController.getTimesheetData';
import saveTimeEntry from '@salesforce/apex/TimesheetPortalController.saveTimeEntry';
import moveTimeEntry from '@salesforce/apex/TimesheetPortalController.moveTimeEntry';
import deleteTimeEntry from '@salesforce/apex/TimesheetPortalController.deleteTimeEntry';
import submitWeek from '@salesforce/apex/TimesheetPortalController.submitWeek';
import saveExpense from '@salesforce/apex/TimesheetPortalController.saveExpense';
import deleteExpense from '@salesforce/apex/TimesheetPortalController.deleteExpense';
import { NavigationMixin } from 'lightning/navigation';

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

export default class extends NavigationMixin(LightningElement) {
    @track contactId;
    @track contactName = '';
    @track contactTitle = '';
    
    // ✅ Navigation State
    @track activeTab = 'timesheet'; // 'timesheet' | 'expenses'
    @track activeView = 'weekly';   // 'weekly' | 'list'
    
    @track currentStartDate = new Date();
    @track dateHeaders = [];
    @track calendarColumns = [];

    // ─── ADD THESE TRACK VARIABLES ───
    @track listSortField = 'Date__c';
    @track listSortDirection = 'desc';
    @track expandedRowIds = []; // Tracks which rows have their notes expanded
    
    wiredResult;
    allProjectResources = [];
    allTimeEntries = [];
    allExpenses = [];
    // 🎨 CLEAN SAAS PALETTE (Vibrant borders, backgrounds handled by CSS)
    _colorPalette = [
        { border: '#0176D3', dot: '#0176D3' }, // Salesforce Blue
        { border: '#41B658', dot: '#41B658' }, // Mint Green
        { border: '#E96B54', dot: '#E96B54' }, // Coral
        { border: '#7856FF', dot: '#7856FF' }, // Purple
        { border: '#F29A2E', dot: '#F29A2E' }  // Orange
    ];
    _projectColorMap = {};

    @track searchTerm = '';
    @track currentPage = 1;
    @track recordsPerPage = 20;
    @track totalRecords = 0;
    @track totalPages = 1;
    @track listSearchTerm = '';

    // Time Entry State
    @track isEntryModalOpen = false;
    @track selectedEntryId = null;
    @track entryDate = '';
    @track entryProjectId = '';
    @track entryType = 'Regular';
    @track entryStartTime = '09:00';
    @track entryEndTime = '17:00';
    @track entryBreakTime = 0;
    @track entryComments = '';

    @track attachedFileId = null; // ✅ Tracks the actual ID for previewing

    // ✅ Restored Expense Modal State
    @track isExpenseModalOpen = false;
    @track selectedExpenseId = null;
    @track expenseProjectId = '';
    @track expenseDate = '';
    @track expenseAmount = '';
    @track expenseCategory = '';
    @track expenseDescription = '';
    @track expenseComments = '';

    @track isDeleteConfirmOpen = false;
    @track deleteType = '';
    pendingDeleteId = null;

    @track copiedEntry = null;
    @track isCutAction = false;
    cutEntryId = null;
    actionHistory = [];
    @track isUndoDisabled = true;

    @track hoverCard = { visible: false };
    _hoverTimeout = null;
    _hoverEntryId = null;

    @track listTimeframe = 'Weekly'; // 'Weekly' | 'Monthly'

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

    
    @track selectedEntryIds = [];
    @track isBulkModalOpen = false;
    @track bulkType = '';
    @track inlineEditEntryId = null;
    @track weeklyTotalHours = '0.0';

    // Expense Modal State
    @track attachedFileName = '';
    fileBase64 = null; // Doesn't need to be tracked, just stored

    expenseCategoryOptions = [
        { label: '✈️ Travel', value: 'Travel' },
        { label: '🍽 Meals', value: 'Meals' },
        { label: '🏨 Lodging', value: 'Lodging' },
        { label: '💻 Equipment', value: 'Equipment' },
        { label: '🔧 Other', value: 'Other' }
    ];
    recordsPerPageOptions = [
        { label: '10', value: '10' },
        { label: '20', value: '20' },
        { label: '50', value: '50' },
        { label: 'All', value: '1000' }
    ];
    _typeClassMap = {
        'Regular': 'entry-regular',
        'Overtime': 'entry-overtime',
        'Double Time': 'entry-doubletime',
        'Sick': 'entry-sick',
        'PTO': 'entry-pto',
        'Holiday': 'entry-holiday',
        'Training': 'entry-training'
    };
    _statusShortMap = {
        'Draft': 'D',
        'Submitted': 'S',
        'Approved': 'A',
        'Rejected': 'R'
    };

    allProjectTasks = []; // ✅ Store dynamic tasks
    @track expenseStatus = 'Draft'; 

    
    
    
    // ─── GETTERS ─────────────────────────────────────────────────────────────
    
    // ✅ NEW: Getter to lock the UI if the expense is submitted/approved
    get isExpenseReadOnly() {
        return this.selectedExpenseId != null && this.expenseStatus !== 'Draft';
    }

    get isTaskDisabled() { return !this.entryProjectId; } // ✅ Disable task dropdown if no project is selected
    
    get timeframeOptions() {
        return [
            { label: 'This Week', value: 'Weekly' },
            { label: 'This Month', value: 'Monthly' }
        ];
    }
    
    get listRangeLabel() {
        if (this.listTimeframe === 'Monthly') {
            return this.currentStartDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        }
        return this.weekRangeLabel;
    }
    // ✅ Restored Tab Getters
    get isTimesheetTab() { return this.activeTab === 'timesheet'; }
    get isExpensesTab() { return this.activeTab === 'expenses'; }
    get timesheetTabClass() { return `portal-tab ${this.activeTab === 'timesheet' ? 'tab-active' : ''}`; }
    get expensesTabClass() { return `portal-tab ${this.activeTab === 'expenses' ? 'tab-active' : ''}`; }
    
    get isWeeklyView() { return this.activeView === 'weekly'; }
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
    get isExpenseEdit() { return !!this.selectedExpenseId; } // ✅ Restored Expense Getter
    get hasSelectedEntries() { return this.selectedEntryIds.length > 0; }
    get selectedEntriesCount() { return this.selectedEntryIds.length; }
    get isEntryCopied() { return this.copiedEntry !== null; }
    get isCutActive() { return this.isCutAction && this.copiedEntry !== null; }

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
    get expenseProjectOptions() { return this.projectOptions; } // ✅ Restored Expense Project Mapper
    
    get processedExpenses() {
        return this.allExpenses.map(e => ({
            ...e,
            displayDate: e.Expense_Date__c ? new Date(e.Expense_Date__c + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
            projectName: e.Project__r?.Name || '—',
            displayAmount: e.Amount__c != null ? `$${parseFloat(e.Amount__c).toFixed(2)}` : '—',
            pillClass: 'status-pill ' + (e.Status__c === 'Approved' ? 'pill-confirmed' : e.Status__c === 'Submitted' ? 'pill-active' : 'pill-pending'),
            status: e.Status__c || 'Draft',
            // Adds our new base class, plus the selected class if clicked
            masterItemClass: this.selectedExpenseId === e.Id ? 'expense-card-item master-item-selected' : 'expense-card-item'
        }));
    }

    get hasExpenses() { return this.processedExpenses.length > 0; }

    // Controls the CSS class for the split view animation
    get masterContainerClass() {
        return this.selectedExpenseId 
            ? 'split-view-master split-view-master-active' 
            : 'split-view-master';
    }

    // ✅ NEW: Dynamic Titles for the right-side detail panel
    get expenseDetailTitle() {
        return this.selectedExpenseId === 'NEW' ? 'New Expense' : 'Expense Details';
    }
    
    get expenseDetailSubtitle() {
        return this.selectedExpenseId === 'NEW' ? 'Unsaved Record' : `ID: ${this.selectedExpenseId}`;
    }
    
    // ✅ ENTERPRISE SIDEBAR GETTER (Strictly Code + Truncated Name)
    get sidebarProjects() {
        const up = DataUtils.uniqueBy(this.allProjectResources, r => r.Project__c);
        const f = up.filter(r => (r.Project__r?.Name || r.Name || '').toLowerCase().includes(this.searchTerm));
        
        return f.map(r => {
            const c = this._projectColorMap[r.Project__c] || this._colorPalette[0];
            const wh = this.allTimeEntries.filter(e =>
                e.Project__c === r.Project__c &&
                this.dateHeaders.length &&
                e.Date__c >= this.dateHeaders[0].dateValue &&
                e.Date__c <= this.dateHeaders[this.dateHeaders.length - 1].dateValue
            ).reduce((s, e) => s + (parseFloat(e.Hours_Worked_Number_Format__c) || 0), 0);

            // Enterprise Project Code (Uses actual field if available, otherwise generates a clean fallback)
            const fallbackCode = r.Project__c ? 'PRJ-' + r.Project__c.substring(11, 15).toUpperCase() : 'PRJ-001';

            return {
                id: r.Project__c,
                projectName: r.Project__r?.Name || r.Name,
                projectCode: r.Project__r?.ProjectCode__c || fallbackCode,
                weekHours: wh.toFixed(1),
                cardStyle: `border-left: 6px solid ${c.border};`
            };
        });
    }

    // ✅ NEW: Dynamically filter tasks based on the selected Project
    get dynamicTaskOptions() {
        if (!this.entryProjectId) {
            return [{ label: 'Select a project first...', value: '' }];
        }
        
        const filteredTasks = this.allProjectTasks.filter(t => t.Project__c === this.entryProjectId);
        
        if (filteredTasks.length === 0) {
            return [{ label: 'No tasks found for this project', value: '' }];
        }

        return filteredTasks.map(t => ({
            label: t.Name,
            value: t.Name // Storing the Name to map to your existing Shift_Type__c field
        }));
    }

    // ✅ NEW: Enterprise Matrix View Data Transformation (Shows ALL Projects)
    get matrixViewData() {
        if (!this.dateHeaders || this.dateHeaders.length === 0) {
            return { rows: [], footer: [], grandTotal: '0.00' };
        }

        const projectMap = {}; 
        const dailyTotals = [0, 0, 0, 0, 0, 0, 0];
        let grandTotal = 0;

        // 1. Initialize the grid with ALL projects the user is assigned to
        this.allProjectResources.forEach(pr => {
            if (pr.Project__c && !projectMap[pr.Project__c]) {
                projectMap[pr.Project__c] = {
                    id: pr.Project__c,
                    projectName: pr.Project__r?.Name || pr.Name,
                    days: [0, 0, 0, 0, 0, 0, 0], // 7 days initialized to 0
                    total: 0
                };
            }
        });

        // 2. Create a fast lookup for which date corresponds to which column index (0-6)
        const dateIndexMap = {};
        this.dateHeaders.forEach((dh, idx) => {
            dateIndexMap[dh.dateValue] = idx;
        });

        // 3. Populate the grid with hours
        this.allTimeEntries.forEach(entry => {
            const colIndex = dateIndexMap[entry.Date__c];
            
            // If the entry falls within this week's dates and we have the project mapped
            if (colIndex !== undefined && projectMap[entry.Project__c]) {
                const hours = parseFloat(entry.Hours_Worked_Number_Format__c) || 0;
                
                projectMap[entry.Project__c].days[colIndex] += hours;
                projectMap[entry.Project__c].total += hours;
                dailyTotals[colIndex] += hours;
                grandTotal += hours;
            }
        });

        // 4. Format the data for the HTML template
        // ✅ FIX: Removed the filter so ALL projects show, even if total is 0
        const activeRows = Object.values(projectMap)
            .sort((a, b) => a.projectName.localeCompare(b.projectName));

        const formattedRows = activeRows.map(r => ({
            ...r,
            // If total is 0, show '-', otherwise show the number
            formattedTotal: r.total > 0 ? r.total.toFixed(2) : '-', 
            formattedDays: r.days.map((d, i) => ({
                key: `${r.id}-${i}`,
                value: d > 0 ? d.toFixed(2) : '-' // Use '-' for empty cells for a cleaner look
            }))
        }));

        const formattedFooter = dailyTotals.map((d, i) => ({
            key: `footer-${i}`,
            value: d > 0 ? d.toFixed(2) : '-'
        }));

        return {
            rows: formattedRows,
            footer: formattedFooter,
            grandTotal: grandTotal > 0 ? grandTotal.toFixed(2) : '0.00'
        };
    }
    get listViewEntries() {
        // 1. Calculate Date Bounds based on Weekly/Monthly selection
        let startStr, endStr;
        if (this.listTimeframe === 'Monthly') {
            const d = new Date(this.currentStartDate);
            const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
            const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
            startStr = DataUtils.getLocalIsoDate(firstDay);
            endStr = DataUtils.getLocalIsoDate(lastDay);
        } else {
            if (!this.dateHeaders.length) return [];
            startStr = this.dateHeaders[0].dateValue;
            endStr = this.dateHeaders[this.dateHeaders.length - 1].dateValue;
        }

        // ✅ NEW: Pre-calculate clashes globally for the List View
        const clashingIds = new Set();
        const entriesByDate = {};
        this.allTimeEntries.forEach(e => {
            if (!entriesByDate[e.Date__c]) entriesByDate[e.Date__c] = [];
            entriesByDate[e.Date__c].push(e);
        });

        // Apply strict time overlap formula to find clashing IDs
        Object.values(entriesByDate).forEach(dayEntries => {
            const processed = dayEntries.map(e => {
                let sMins = TimeUtils.toMinutes(e.Start_Time__c);
                let eMins = TimeUtils.toMinutes(e.End_Time__c);
                if (eMins <= sMins) eMins += 1440; // Handle overnight
                return { id: e.Id, start: sMins, end: eMins };
            });

            for (let i = 0; i < processed.length; i++) {
                for (let j = i + 1; j < processed.length; j++) {
                    if (processed[i].start < processed[j].end && processed[i].end > processed[j].start) {
                        clashingIds.add(processed[i].id);
                        clashingIds.add(processed[j].id);
                    }
                }
            }
        });

        // 2. Filter & Map entries within bounds
        let entries = this.allTimeEntries
            .filter(e => e.Date__c >= startStr && e.Date__c <= endStr)
            .map(e => {
                const res = this.allProjectResources.find(r => r.Project__c === e.Project__c);
                const c = this._projectColorMap[e.Project__c] || this._colorPalette[0];
                const hasNotes = !!e.Additional_Comments__c;
                const isClashing = clashingIds.has(e.Id); // ✅ Check our calculated set
                
                return {
                    ...e,
                    Id: e.Id,
                    displayDate: e.Date__c ? new Date(e.Date__c + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '',
                    projectName: res?.Project__r?.Name || '—',
                    typeLabel: e.Shift_Type__c || 'Regular',
                    startTime: TimeUtils.formatTime12h(e.Start_Time__c) || '—',
                    endTime: TimeUtils.formatTime12h(e.End_Time__c) || '—',
                    hours: parseFloat(e.Hours_Worked_Number_Format__c) || 0,
                    pillClass: 'status-pill ' + (e.Time_Status__c === 'Approved' ? 'pill-confirmed' : e.Time_Status__c === 'Submitted' ? 'pill-active' : e.Time_Status__c === 'Rejected' ? 'pill-rejected' : 'pill-pending'),
                    status: e.Time_Status__c || 'Draft',
                    colorDot: `background:${c.dot};`,
                    isExpanded: this.expandedRowIds.includes(e.Id),
                    expandIcon: this.expandedRowIds.includes(e.Id) ? 'utility:chevrondown' : 'utility:chevronright',
                    hasNotes: hasNotes,
                    notesWarning: !hasNotes,
                    fullNotes: e.Additional_Comments__c || 'No notes provided.',
                    isClashing: isClashing, // ✅ Pass flag to HTML
                    rowClass: isClashing ? 'list-row-clashing' : '' // ✅ Assign red highlight class
                };
            });

        // 3. Apply Filters and Sorting
        if (this.listSearchTerm) {
            const t = this.listSearchTerm.toLowerCase();
            entries = entries.filter(e => e.projectName.toLowerCase().includes(t) || e.typeLabel.toLowerCase().includes(t) || (e.fullNotes && e.fullNotes.toLowerCase().includes(t)));
        }
        entries.sort((a, b) => {
            let valA = a[this.listSortField] || ''; let valB = b[this.listSortField] || '';
            if (this.listSortField === 'projectName') { valA = valA.toLowerCase(); valB = valB.toLowerCase(); }
            else if (this.listSortField === 'hours') { valA = Number(valA); valB = Number(valB); }
            let result = valA < valB ? -1 : valA > valB ? 1 : 0;
            return this.listSortDirection === 'asc' ? result : -result;
        });

        return entries;
    }

    // Handle clicking column headers to sort
    handleSort(e) {
        const field = e.currentTarget.dataset.field;
        if (this.listSortField === field) {
            this.listSortDirection = this.listSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.listSortField = field;
            this.listSortDirection = field === 'Date__c' ? 'desc' : 'asc';
        }
    }

    // Expand/Collapse the notes row
    toggleRowExpand(e) {
        const id = e.currentTarget.dataset.id;
        if (this.expandedRowIds.includes(id)) {
            this.expandedRowIds = this.expandedRowIds.filter(rowId => rowId !== id);
        } else {
            this.expandedRowIds = [...this.expandedRowIds, id];
        }
    }

    // Duplicate an entry straight from the list view
    handleListDuplicate(e) {
        e.stopPropagation();
        const id = e.currentTarget.dataset.id;
        const en = this.allTimeEntries.find(x => x.Id === id);
        if (en) {
            // Open modal with data, but CLEAR the ID so it saves as a new record
            this._openEntryModal(null, en.Date__c, en.Project__c);
            this.entryType = en.Shift_Type__c || 'Regular';
            this.entryStartTime = TimeUtils.normalizeTime(en.Start_Time__c) || '09:00';
            this.entryEndTime = TimeUtils.normalizeTime(en.End_Time__c) || '17:00';
            this.entryBreakTime = en.Break_Time__c || 0;
            this.entryComments = en.Additional_Comments__c || '';
            this.showToast('Duplicating', 'Adjust the date or times, then save.', 'info');
        }
    }

    // ─── LIFECYCLE & WIRE ────────────────────────────────────────────────────
    connectedCallback() {
        const p = new URLSearchParams(window.location.search);
        this.contactId = p.get('contactId') || p.get('c__contactId');
        if (!DataUtils.isValidSfId(this.contactId)) {
            this.showToast('Authentication Error', 'Invalid Contact ID.', 'error');
            return;
        }
        const d = new Date(), dy = d.getDay();
        d.setDate(d.getDate() - dy + (dy === 0 ? -6 : 1));
        this.currentStartDate = new Date(d);
        this.currentStartDate.setHours(0, 0, 0, 0);
        this.generateDateHeaders();
        this.entryDate = DataUtils.getLocalIsoDate();
        this.expenseDate = DataUtils.getLocalIsoDate(); // ✅ Reset expense date
    }

    disconnectedCallback() {
        window.removeEventListener('mousemove', this._onDrawMove);
        window.removeEventListener('mouseup', this._onDrawEnd);
        window.removeEventListener('mousemove', this._onResizeMove);
        window.removeEventListener('mouseup', this._onResizeEnd);
    }

    @wire(getTimesheetData, { contactId: '$contactId' })
    wiredData(res) {
        this.wiredResult = res;
        if (res.data) {
            try {
                this.allProjectResources = res.data.projectResources ? DataUtils.deepClone(res.data.projectResources) : [];
                this.allTimeEntries = res.data.timeEntries ? DataUtils.deepClone(res.data.timeEntries) : [];
                this.allExpenses = res.data.expenses ? DataUtils.deepClone(res.data.expenses) : [];
                this.allProjectTasks = res.data.projectTasks ? DataUtils.deepClone(res.data.projectTasks) : [];
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

    // ─── NAVIGATION ──────────────────────────────────────────────────────────
    switchToTimesheet() { this.activeTab = 'timesheet'; } // ✅ Restored
    switchToExpenses() { this.activeTab = 'expenses'; }   // ✅ Restored
    switchToWeekly() { this.activeView = 'weekly'; this.buildGrid(); }
    switchToList() { this.activeView = 'list'; }
    handlePrevious() {
        if (this.activeView === 'list' && this.listTimeframe === 'Monthly') {
            this.currentStartDate.setMonth(this.currentStartDate.getMonth() - 1);
        } else {
            this.currentStartDate.setDate(this.currentStartDate.getDate() - 7);
        }
        this._alignDateToWeekStart();
        this.generateDateHeaders(); 
        this.buildGrid(); 
    }
    
    handleNext() {
        if (this.activeView === 'list' && this.listTimeframe === 'Monthly') {
            this.currentStartDate.setMonth(this.currentStartDate.getMonth() + 1);
        } else {
            this.currentStartDate.setDate(this.currentStartDate.getDate() + 7);
        }
        this._alignDateToWeekStart();
        this.generateDateHeaders(); 
        this.buildGrid(); 
    }
    
   handleToday() {
        // 1. Set to exactly right now
        this.currentStartDate = new Date();
        
        // 2. Let your helper function align it to Monday at 00:00:00
        this._alignDateToWeekStart();
        
        // 3. Rebuild the UI
        this.generateDateHeaders();
        this.buildGrid();
    }
    handleDatePick(e) {
        if (!e.target.value) return;
        const [y, m, d] = e.target.value.split('-');
        this.currentStartDate = new Date(y, m - 1, d, 0, 0, 0, 0);
        this.generateDateHeaders();
        this.buildGrid();
    }

    _alignDateToWeekStart() {
        const dy = this.currentStartDate.getDay();
        this.currentStartDate.setDate(this.currentStartDate.getDate() - dy + (dy === 0 ? -6 : 1));
        this.currentStartDate.setHours(0, 0, 0, 0);
    }

    handleTimeframeChange(e) {
        this.listTimeframe = e.detail.value;
    }
    handleSearch(e) { this.searchTerm = e.target.value?.toLowerCase() || ''; this.currentPage = 1; }
    handleListSearch(e) { this.listSearchTerm = e.target.value?.toLowerCase() || ''; }
    handleRecordsPerPageChange(e) { this.recordsPerPage = parseInt(e.detail.value || e.target.value, 10) || 20; this.currentPage = 1; }
    handlePrevPage() { if (this.currentPage > 1) { this.currentPage--; this.buildGrid(); } }
    handleNextPage() { if (this.currentPage < this.totalPages) { this.currentPage++; this.buildGrid(); } }

    generateDateHeaders() {
        const h = [], b = new Date(this.currentStartDate), ts = DataUtils.getLocalIsoDate();
        for (let i = 0; i < 7; i++) {
            const d = new Date(b);
            d.setDate(b.getDate() + i);
            const iso = DataUtils.getLocalIsoDate(d);
            h.push({
                columnId: iso,
                dateValue: iso,
                display: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
                headerCellClass: iso === ts ? 'header-cell header-cell-today' : 'header-cell',
                todayLabelClass: iso === ts ? 'today-label' : '',
                isWeekend: d.getDay() === 0 || d.getDay() === 6
            });
        }
        this.dateHeaders = h;
    }

    // ─── GRID BUILDER ────────────────────────────────────────────────────────
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
                visualBlocks.push({
                    ...entry, visualDate: entry.Date__c, vStartMins: sMins, vEndMins: 1440,
                    isOvernightPart: 'start', renderKey: entry.Id + '-start'
                });
                const nextDay = new Date(entry.Date__c + 'T00:00:00');
                nextDay.setDate(nextDay.getDate() + 1);
                visualBlocks.push({
                    ...entry, visualDate: DataUtils.getLocalIsoDate(nextDay), vStartMins: 0, vEndMins: eMinsRaw,
                    isOvernightPart: 'end', renderKey: entry.Id + '-end'
                });
            } else {
                visualBlocks.push({
                    ...entry, visualDate: entry.Date__c, vStartMins: sMins,
                    vEndMins: entry.End_Time__c ? eMinsRaw : (sMins + 60),
                    isOvernightPart: false, renderKey: entry.Id
                });
            }
        });

        this.calendarColumns = this.dateHeaders.map(header => {
            let dayBlocks = visualBlocks.filter(vb => vb.visualDate === header.dateValue);
            if (searchTermStr) {
                dayBlocks = dayBlocks.filter(vb => (projectMap[vb.Project__c] || '').toLowerCase().includes(searchTermStr));
            }
            let clonedBlocks = DataUtils.deepClone(dayBlocks);

            // ✅ FIX 1: Sort the blocks by start time first so they cascade neatly
            clonedBlocks.sort((a, b) => a.vStartMins - b.vStartMins);

            // Reset clash flag for a clean slate
            clonedBlocks.forEach(b => b.isClashing = false); 

            // ✅ FIX 2: Strict Time-Based Overlap Logic
            clonedBlocks.forEach((b1, idx) => {
                b1._level = 0;
                for (let i = 0; i < idx; i++) {
                    const b2 = clonedBlocks[i];
                    
                    // STRICT TIME OVERLAP FORMULA
                    // This ONLY returns true if the actual minutes intersect.
                    // Touching edges (e.g., 11:00 to 12:00 and 12:00 to 1:00) safely bypass this!
                    const isOverlapping = (b1.vStartMins < b2.vEndMins) && (b1.vEndMins > b2.vStartMins);

                    if (isOverlapping) {
                        b1.isClashing = true; // Mark card 1 as clashing
                        b2.isClashing = true; // Mark card 2 as clashing
                        
                        // Visually push the clashing card to the right (side-by-side)
                        if (b1._level <= b2._level) {
                            b1._level = b2._level + 1;
                        }
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

            return { 
                ...header, 
                isPast: header.dateValue < todayStr,
                isDrawingGhost: this.activeGhostId === header.dateValue, 
                entries: mappedEntries 
            };
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
        if (vb.Time_Status__c === 'Approved') css += ' is-locked';

        if (vb.isOvernightPart === 'start') css += ' overnight-start';
        if (vb.isOvernightPart === 'end') css += ' overnight-end';

        // ✅ NEW: Calculate exact hours based on the pixel height to determine if it's a short shift
        const topPx = vb.vStartMins;
        const heightPx = Math.max(15, vb.vEndMins - vb.vStartMins);
        const shiftDurationHours = heightPx / 60; // 60 pixels = 1 hour

        // ✅ NEW: Apply the 'short-shift' class if it's 1.5 hours (90 mins) or less
        if (shiftDurationHours <= 1.5) {
            css += ' short-shift';
        }

        const h = parseFloat(vb.Hours_Worked_Number_Format__c) || 0;
        const tr = (vb.Start_Time__c && vb.End_Time__c) 
            ? `${TimeUtils.formatTime12h(vb.Start_Time__c)} – ${TimeUtils.formatTime12h(vb.End_Time__c)}` 
            : `${h.toFixed(1)}h`;

        let pc = 'status-pill pill-pending';
        if (vb.Time_Status__c === 'Approved') pc = 'pill-confirmed';
        else if (vb.Time_Status__c === 'Submitted') pc = 'pill-active';
        else if (vb.Time_Status__c === 'Rejected') pc = 'pill-rejected';

        const lp = 4 + (vb._level * 18);
        const zi = 3 + vb._level;
        const glassyBgColor = c.bg + 'D9';
        if (vb.isClashing) css += ' clashing-shift';

        return {
            ...vb,
            id: vb.Id,
            isClashing: vb.isClashing,
            renderKey: vb.renderKey,
            description: vb.Additional_Comments__c || vb.Shift_Type__c || 'Time Entry',
            shortDesc: this._shortDesc(vb.Additional_Comments__c || vb.Shift_Type__c || ''),
            timeRange: tr,
            hours: h.toFixed(1),
            displayDate: vb.Date__c ? new Date(vb.Date__c + 'T00:00:00').toLocaleDateString() : '',
            cssClass: css,
            dynamicStyle: `top:${topPx}px; height:${heightPx}px; left:${lp}px; z-index:${zi}; border-left-color: ${c.border};`,
            pillClass: pc,
            statusShort: ss,
            typeLabel: vb.Shift_Type__c || 'Regular',
            isEditable: vb.Time_Status__c !== 'Approved',
            isLocked: vb.Time_Status__c === 'Approved',
            isCutPending: this.isCutAction && this.cutEntryId === vb.Id,
            isSelected: this.selectedEntryIds.includes(vb.Id),
            projectName: r?.Project__r?.Name || '—',
            colorDot: `background:${c.dot};`,
            btnCutClass: vb.Time_Status__c !== 'Approved' ? 'action-btn btn-cut' : 'btn-disabled',
            btnDeleteClass: vb.Time_Status__c !== 'Approved' ? 'action-btn btn-delete' : 'btn-disabled',
            showResizeTop: vb.Time_Status__c !== 'Approved' && vb.isOvernightPart !== 'end',
            showResizeBottom: vb.Time_Status__c !== 'Approved' && vb.isOvernightPart !== 'start'
        };
    }

    _shortDesc(t) {
        if (!t) return '';
        const w = t.trim().split(/\s+/);
        return w.length <= 3 ? t : w.slice(0, 3).join(' ') + '…';
    }

    // ─── DRAG TO CREATE ──────────────────────────────────────────────────────
    handleCreateDragStart(e) {
        if (this.isEntryCopied) {
            return;
        }
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

    // ─── CARD CLICKS & ENTRY MODAL ───────────────────────────────────────────
    handleCardDoubleClick(e) {
        if (e.target.closest('.shift-action-bar') || e.target.classList.contains('resize-handle')) return;
        const eid = e.currentTarget.dataset.id, en = this.allTimeEntries.find(x => x.Id === eid);
        if (!en) return;
        if (en.Time_Status__c === 'Approved') {
            this.showToast('Read Only', 'Approved entries are locked.', 'info');
            return;
        }
        this.selectedEntryId = en.Id;
        this.entryDate = en.Date__c;
        this.entryProjectId = en.Project__c;
        this.entryType = en.Shift_Type__c || 'Regular';
        this.entryStartTime = TimeUtils.normalizeTime(en.Start_Time__c) || '09:00';
        this.entryEndTime = TimeUtils.normalizeTime(en.End_Time__c) || '17:00';
        this.entryBreakTime = en.Break_Time__c || 0;
        this.entryComments = en.Additional_Comments__c || '';
        this.isEntryModalOpen = true;
    }

    _openEntryModal(eid, date, pid) {
        this.selectedEntryId = eid;
        this.entryDate = date;
        this.entryProjectId = pid || '';
        this.entryType = 'Regular';
        if (!this.entryStartTime) this.entryStartTime = '09:00';
        if (!this.entryEndTime) this.entryEndTime = '17:00';
        this.entryBreakTime = 0;
        this.entryComments = '';
        this.isEntryModalOpen = true;
    }

    closeEntryModal() { this.isEntryModalOpen = false; }

    saveEntryModal() {
        if (!DataUtils.isValidSfId(this.contactId)) {
            this.showToast('Error', 'Contact ID missing.', 'error');
            return;
        }
        if (!this.entryProjectId) {
            this.showToast('Required', 'Select a project.', 'warning');
            return;
        }
        if (!this.entryDate || !this.entryStartTime || !this.entryEndTime) {
            this.showToast('Required', 'Fill date/time.', 'warning');
            return;
        }
        const [sH, sM] = this.entryStartTime.split(':').map(Number), [eH, eM] = this.entryEndTime.split(':').map(Number);
        if (eH === sH && eM === sM) {
            this.showToast('Invalid', 'Start/End cannot be equal.', 'error');
            return;
        }
        const pr = this.allProjectResources.find(r => r.Project__c === this.entryProjectId);
        if (!pr) {
            this.showToast('Error', 'Project not found.', 'error');
            return;
        }
        saveTimeEntry({
            contactId: this.contactId,
            projectResourceId: pr.Id,
            projectId: this.entryProjectId,
            shiftType: this.entryType,
            entryDate: this.entryDate,
            startHour: sH,
            startMinute: sM,
            endHour: eH,
            endMinute: eM,
            breakTime: parseFloat(this.entryBreakTime) || 0,
            comments: this.entryComments,
            existingId: this.selectedEntryId
        }).then(() => {
            this.showToast('Saved', 'Time entry saved.', 'success');
            this.isEntryModalOpen = false;
            return refreshApex(this.wiredResult);
        }).catch(err => this.showToast('Error', err?.body?.message || err?.message || 'Save failed', 'error'));
    }

    // ─── CARD DRAG & DROP ────────────────────────────────────────────────────
    _dragCardOffsetY = 0; // Add this near the top of your class with your other variables

    // ─── CARD DRAG & DROP ────────────────────────────────────────────────────
    handleDragStart(e) {
        if (e.currentTarget.dataset.editable !== 'true') { e.preventDefault(); return; }
        const eid = e.currentTarget.dataset.id, sn = this.allTimeEntries.find(x => x.Id === eid);
        
        // ✅ NEW: Record exactly where the user's mouse grabbed the card (offset from the top)
        const rect = e.currentTarget.getBoundingClientRect();
        this._dragCardOffsetY = e.clientY - rect.top;

        if (sn) this.pushToUndoStack('MOVE', { ...sn });
        e.dataTransfer.setData('text/plain', eid);
    }
    handleDragOver(e) { e.preventDefault(); }
    handleCardMouseDown(e) {
        if (!e.target.closest('.resize-handle')) {
            const el = e.currentTarget;
            if (el.dataset.editable === 'true') {
                el.setAttribute('draggable', 'true');
                el.classList.add('is-dragging');
            }
        }
    }
    handleCardMouseUp(e) { e.currentTarget.removeAttribute('draggable'); e.currentTarget.classList.remove('is-dragging'); }
    handleDragEnd(e) { e.currentTarget.removeAttribute('draggable'); e.currentTarget.classList.remove('is-dragging'); }

    handleDrop(e) {
        e.preventDefault();
        const eid = e.dataTransfer.getData('text/plain'), td = e.currentTarget.dataset.date;
        const orig = this.allTimeEntries.find(x => x.Id === eid);
        if (!orig) return;
        const pr = this.allProjectResources.find(r => r.Project__c === orig.Project__c);
        if (!pr) { this.showToast('Error', 'Project not found.', 'error'); return; }
        
        let sH = 9, sM = 0, n = TimeUtils.normalizeTime(orig.Start_Time__c);
        if (n) [sH, sM] = n.split(':').map(Number);
        
        const rect = e.currentTarget.getBoundingClientRect();
        
        // ✅ NEW: Calculate the TRUE top of the card by subtracting the grab offset
        const rawTopPx = (e.clientY - rect.top) - (this._dragCardOffsetY || 0);

        // ✅ NEW: Force the top of the card to snap to the nearest 15-minute interval
        const dm = Math.max(0, Math.round(rawTopPx / 15) * 15); 
        
        // Calculate the original duration so the card doesn't stretch/shrink
        const dur = (orig.End_Time__c ? TimeUtils.toMinutes(orig.End_Time__c) : (sH * 60 + sM + 60)) - (sH * 60 + sM);

        sH = Math.floor(dm / 60);
        sM = dm % 60;
        
        const endM = dm + (dur > 0 ? dur : 60);
        const eH = Math.floor(endM / 60) % 24;
        const eM = endM % 60;

        moveTimeEntry({
            entryId: eid, newProjectResourceId: pr.Id, newProjectId: orig.Project__c,
            newDate: td, startHour: sH, startMinute: sM, endHour: eH, endMinute: eM
        }).then(() => refreshApex(this.wiredResult)).catch(err => {
            this.showToast('Error', err.body?.message || 'Move failed.', 'error');
            this.actionHistory.pop();
            this.isUndoDisabled = this.actionHistory.length === 0;
            return refreshApex(this.wiredResult);
        });
    }

    // ─── CARD RESIZING ───────────────────────────────────────────────────────
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

        // 1. Calculate the proposed new times FIRST
        if (this._resizeDirection === 'top') {
            let deltaMins = Math.round(dy / pixelsPerMinute);
            newStartMins = this._originalStartMins + deltaMins;
            
            // ✅ NEW: Force resize to snap to 15-minute intervals (0, 15, 30, 45)
            newStartMins = Math.round(newStartMins / 15) * 15;

            const minStart = Math.max(0, this._originalEndMins - 1440); 
            const maxStart = this._originalEndMins - 15; 
            newStartMins = Math.max(minStart, Math.min(newStartMins, maxStart));
        } else {
            let deltaMins = Math.round(dy / pixelsPerMinute);
            newEndMins = this._originalEndMins + deltaMins;
            
            // ✅ NEW: Force resize to snap to 15-minute intervals (0, 15, 30, 45)
            newEndMins = Math.round(newEndMins / 15) * 15;

            const minEnd = this._originalStartMins + 15;
            const maxEnd = this._originalStartMins + 1440; 
            newEndMins = Math.max(minEnd, Math.min(newEndMins, maxEnd));
        }

        // 2. STRICT OVERLAP CHECK (Touching edges safely pass this check)
        const wouldOverlap = this.allTimeEntries.some(other => {
            if (other.Id === entry.Id || other.Date__c !== entry.Date__c) return false;
            
            const otherStart = TimeUtils.toMinutes(other.Start_Time__c);
            let otherEnd = TimeUtils.toMinutes(other.End_Time__c);
            if (otherEnd <= otherStart) otherEnd += 1440; 
            
            return Math.max(newStartMins, otherStart) < Math.min(newEndMins, otherEnd);
        });

        // 3. Block the resize drag visually if it's hitting another card
        if (wouldOverlap) {
            this.resizeTooltip.text = '⚠️ Time Conflict';
            this.resizeTooltip.style = `left:${e.clientX+20}px;top:${e.clientY}px;color:#ea001e;`;
            return; 
        }
        
        // 4. If no overlap, apply the visual CSS updates
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
            contactId: this.contactId, projectResourceId: projectRes.Id, projectId: entry.Project__c,
            shiftType: entry.Shift_Type__c, entryDate: entry.Date__c,
            startHour: sH, startMinute: sM, endHour: eH, endMinute: eM,
            breakTime: entry.Break_Time__c || 0, comments: entry.Additional_Comments__c, existingId: entry.Id
        }).then(() => refreshApex(this.wiredResult)).catch(err => {
            this.showToast('Error', err.body?.message || 'Failed to save changes.', 'error');
            this._resizingEl.style.top = `${this._originalTop}px`;
            this._resizingEl.style.height = `${this._originalHeight}px`;
            this.buildGrid();
        });
    };

    // ─── CUT/COPY/PASTE ──────────────────────────────────────────────────────
    handleBtnCut(e) {
        e.stopPropagation();
        const en = this.allTimeEntries.find(x => x.Id === e.currentTarget.dataset.id);
        if (!en) return;
        this.copiedEntry = { ...en };
        this.isCutAction = true;
        this.cutEntryId = en.Id;
        this.buildGrid();
        this.showToast('Cut', 'Entry ready to move.', 'info');
    }

    handleBtnCopy(e) {
        e.stopPropagation();
        const en = this.allTimeEntries.find(x => x.Id === e.currentTarget.dataset.id);
        if (!en) return;
        this.copiedEntry = { ...en };
        this.isCutAction = false;
        this.cutEntryId = null;
        this.buildGrid();
        this.showToast('Copied', 'Entry copied.', 'info');
    }

    clearClipboard() {
        this.copiedEntry = null;
        this.isCutAction = false;
        this.cutEntryId = null;
        this.buildGrid();
    }

    handlePaste(e) {
        e.stopPropagation();
        if (!this.copiedEntry) return;
        const dc = e.currentTarget.closest('.day-column'), td = dc?.dataset.date;
        if (!td) return;
        const orig = this.copiedEntry, wasCut = this.isCutAction;
        this.clearClipboard();
        const pr = this.allProjectResources.find(r => r.Project__c === orig.Project__c);
        if (!pr) { this.showToast('Error', 'Project not found.', 'error'); return; }
        const sn = TimeUtils.normalizeTime(orig.Start_Time__c), en = TimeUtils.normalizeTime(orig.End_Time__c);
        let [sH, sM] = sn ? sn.split(':').map(Number) : [9, 0];
        let [eH, eM] = en ? en.split(':').map(Number) : [17, 0];
        const rect = dc.getBoundingClientRect(), off = e.clientY - rect.top;
        if (off >= 0) {
            const dm = Math.round(off / 15) * 15, dur = (eH * 60 + eM) - (sH * 60 + sM);
            sH = Math.floor(dm / 60);
            sM = dm % 60;
            const endM = dm + (dur > 0 ? dur : 60);
            eH = Math.floor(endM / 60) % 24;
            eM = endM % 60;
        }
        if (wasCut) {
            moveTimeEntry({ entryId: orig.Id, newProjectResourceId: pr.Id, newProjectId: orig.Project__c, newDate: td, startHour: sH, startMinute: sM })
            .then(() => refreshApex(this.wiredResult)).catch(err => this.showToast('Error', err.body?.message, 'error'));
        } else {
            saveTimeEntry({ contactId: this.contactId, projectResourceId: pr.Id, projectId: orig.Project__c, shiftType: orig.Shift_Type__c, entryDate: td, startHour: sH, startMinute: sM, endHour: eH, endMinute: eM, breakTime: orig.Break_Time__c || 0, comments: orig.Additional_Comments__c, existingId: null })
            .then(() => refreshApex(this.wiredResult)).catch(err => this.showToast('Error', err.body?.message, 'error'));
        }
    }

    // ─── INLINE EDIT ─────────────────────────────────────────────────────────
    handleInlineEditStart(e) {
        e.stopPropagation();
        if (e.currentTarget.dataset.editable === 'false') return;
        this.inlineEditEntryId = e.currentTarget.dataset.id;
        this.hoverCard = { ...this.hoverCard, visible: false };
        this.buildGrid();
        setTimeout(() => {
            const el = this.template.querySelector(`input.inline-edit-input[data-id="${this.inlineEditEntryId}"]`);
            if (el) { el.focus(); el.select(); }
        }, 50);
    }
    handleInlineEditBlur(e) { this._saveInlineEdit(e.target.dataset.id, e.target.value); }
    handleInlineEditKey(e) {
        if (e.key === 'Enter') e.target.blur();
        else if (e.key === 'Escape') { this.inlineEditEntryId = null; this.buildGrid(); }
    }
    _saveInlineEdit(eid, nc) {
        if (!eid) return;
        this.inlineEditEntryId = null;
        const en = this.allTimeEntries.find(x => x.Id === eid);
        if (!en || en.Additional_Comments__c === nc) { this.buildGrid(); return; }
        const sn = TimeUtils.normalizeTime(en.Start_Time__c), [sH, sM] = sn ? sn.split(':').map(Number) : [9, 0];
        const en2 = TimeUtils.normalizeTime(en.End_Time__c), [eH, eM] = en2 ? en2.split(':').map(Number) : [17, 0];
        const pr = this.allProjectResources.find(r => r.Project__c === en.Project__c);
        if (!pr) return;
        saveTimeEntry({ contactId: this.contactId, projectResourceId: pr.Id, projectId: en.Project__c, shiftType: en.Shift_Type__c, entryDate: en.Date__c, startHour: sH, startMinute: sM, endHour: eH, endMinute: eM, breakTime: en.Break_Time__c || 0, comments: nc, existingId: eid }).then(() => refreshApex(this.wiredResult)).catch(() => this.buildGrid());
    }

    // ─── BULK EDIT & LIST VIEW ───────────────────────────────────────────────
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
            return saveTimeEntry({ contactId: this.contactId, projectResourceId: pr.Id, projectId: en.Project__c, shiftType: this.bulkType || en.Shift_Type__c, entryDate: en.Date__c, startHour: sH, startMinute: sM, endHour: eH, endMinute: eM, breakTime: en.Break_Time__c || 0, comments: en.Additional_Comments__c, existingId: id })
            .then(r => ({ status: 'fulfilled', id, r })).catch(err => ({ status: 'rejected', id, reason: err?.body?.message }));
        });
        Promise.allSettled(ps).then(res => {
            const f = res.filter(r => r.status === 'fulfilled' && r.value?.status === 'fulfilled');
            const j = res.filter(r => r.status === 'rejected' || r.value?.status === 'rejected');
            let m = `${f.length} updated.`;
            if (j.length) m += ` ${j.length} failed.`;
            this.showToast(j.length === res.length ? 'Error' : 'Bulk Edit Complete', m, j.length === res.length ? 'error' : j.length ? 'warning' : 'success');
            this.isBulkModalOpen = false;
            this.clearSelection();
            return refreshApex(this.wiredResult);
        });
    }

    handleSubmitWeek() {
        if (!this.dateHeaders?.length) return;
        submitWeek({ contactId: this.contactId, weekStart: this.dateHeaders[0].dateValue, weekEnd: this.dateHeaders[this.dateHeaders.length - 1].dateValue })
        .then(c => { this.showToast(c === 0 ? 'Info' : 'Success', c === 0 ? 'No drafts found.' : `${c} entries submitted.`, c === 0 ? 'info' : 'success'); return refreshApex(this.wiredResult); })
        .catch(err => this.showToast('Error', err.body?.message || 'Submit failed.', 'error'));
    }
    handleListEdit(e) {
        e.stopPropagation();
        this.selectedEntryId = e.currentTarget.dataset.id;
        const en = this.allTimeEntries.find(x => x.Id === this.selectedEntryId);
        if (en) {
            this.entryDate = en.Date__c;
            this.entryProjectId = en.Project__c;
            this.entryType = en.Shift_Type__c || 'Regular';
            this.entryStartTime = TimeUtils.normalizeTime(en.Start_Time__c) || '09:00';
            this.entryEndTime = TimeUtils.normalizeTime(en.End_Time__c) || '17:00';
            this.entryBreakTime = en.Break_Time__c || 0;
            this.entryComments = en.Additional_Comments__c || '';
            this.isEntryModalOpen = true;
        }
    }




    // ✅ Handle clicking a record in the 35% left list
    handleExpenseSelect(e) {
        const expId = e.currentTarget.dataset.id;
        const exp = this.allExpenses.find(x => x.Id === expId);
        
        if (exp) {
            this.selectedExpenseId = exp.Id;
            this.expenseProjectId = exp.Project__c;
            this.expenseDate = exp.Expense_Date__c;
            this.expenseAmount = exp.Amount__c != null ? String(exp.Amount__c) : '';
            this.expenseCategory = exp.Category__c || '';
            this.expenseDescription = exp.Description__c || '';
            this.expenseComments = exp.Comments__c || '';
            this.expenseStatus = exp.Status__c || 'Draft';
            
            // ✅ NEW: Check if Apex returned an attached file for this record
            if (exp.ContentDocumentLinks && exp.ContentDocumentLinks.length > 0) {
                const link = exp.ContentDocumentLinks[0];
                const doc = link.ContentDocument;
                this.attachedFileName = doc.Title + (doc.FileExtension ? '.' + doc.FileExtension : '');
                
                // ✅ NEW: Save the ID for the previewer
                this.attachedFileId = link.ContentDocumentId;
            } else {
                this.attachedFileName = ''; 
            }
            
            // Always clear the base64 data so we don't accidentally re-upload an old file
            this.fileBase64 = null; 
        }
    }

    // ✅ NEW: Opens the native Salesforce File Previewer
    // ✅ FIXED: Bulletproof file preview launcher
    previewFile(event) {
        // Prevent the click from triggering anything else on the page
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }

        // Failsafe check
        if (!this.attachedFileId) {
            this.showToast('Notice', 'File ID is missing. Try refreshing the page.', 'warning');
            return;
        }
        
        // Command Salesforce to open the theater-mode previewer
        this[NavigationMixin.Navigate]({
            type: 'standard__namedPage',
            attributes: {
                pageName: 'filePreview'
            },
            state: {
                selectedRecordId: this.attachedFileId
            }
        });
    }
    // ─── EXPENSE HANDLING (✅ RESTORED) ───────────────────────────────────────
    openAddExpense() {
        this.selectedExpenseId = 'NEW';
        this.expenseProjectId = '';
        this.expenseDate = DataUtils.getLocalIsoDate();
        this.expenseAmount = '';
        this.expenseCategory = '';
        this.expenseDescription = '';
        this.expenseComments = '';
        this.expenseStatus = 'Draft'; 
        this.removeAttachmentLocalOnly(); 
    }

    handleEditExpense(e) {
        e.stopPropagation();
        const exp = this.allExpenses.find(x => x.Id === e.currentTarget.dataset.id);
        if (!exp) return;
        this.selectedExpenseId = exp.Id;
        this.expenseProjectId = exp.Project__c;
        this.expenseDate = exp.Expense_Date__c || DataUtils.getLocalIsoDate();
        this.expenseAmount = exp.Amount__c != null ? String(exp.Amount__c) : '';
        this.expenseCategory = exp.Category__c || '';
        this.expenseDescription = exp.Description__c || '';
        this.expenseComments = exp.Comments__c || '';
        this.isExpenseModalOpen = true;
    }

    closeExpenseModal() { this.isExpenseModalOpen = false;
        this.removeAttachment();
     }

    // ✅ Keep your original function name
    // ✅ UPDATED: Bulletproof Save Function with deep error tracking
    saveExpenseModal() {
        if (!this.expenseProjectId || !this.expenseDate || !this.expenseAmount) {
            this.showToast('Required', 'Please fill all required fields.', 'warning');
            return;
        }

        // If it's a brand new record (ID is 'NEW'), pass null to Apex so it creates a new record
        const existingIdToPass = this.selectedExpenseId === 'NEW' ? null : this.selectedExpenseId;

        saveExpense({
            contactId: this.contactId,
            projectId: this.expenseProjectId,
            expenseDate: this.expenseDate,
            amount: parseFloat(this.expenseAmount),
            category: this.expenseCategory,
            description: this.expenseDescription,
            comments: this.expenseComments,
            existingId: existingIdToPass, 
            fileName: this.attachedFileName, 
            base64Data: this.fileBase64      
        })
        .then(newId => {
            this.showToast('Saved', 'Expense saved successfully.', 'success');
            this.selectedExpenseId = newId; 
            this.removeAttachmentLocalOnly(); 
            
            // ✅ This is what was likely crashing if refreshApex wasn't imported!
            return refreshApex(this.wiredResult);
        })
        .catch(err => {
            // ✅ Make the error LOUD so we know exactly what is failing
            console.error('SAVE EXPENSE ERROR CAUGHT:', err);
            
            // Extract the deepest error message Salesforce provides
            let errorMessage = 'Save failed. Check console.';
            if (err.body && err.body.message) {
                errorMessage = err.body.message;
            } else if (err.message) {
                errorMessage = err.message;
            }
            
            this.showToast('Error', errorMessage, 'error');
        });
    }

    // ─── EXPENSE FILE UPLOAD LOGIC ───
    handleFileChange(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Ensure file is under 3MB to respect Salesforce Apex limits
        if (file.size > 3000000) {
            this.showToast('File Too Large', 'Please select a file smaller than 3MB.', 'error');
            return;
        }

        this.attachedFileName = file.name;
        
        // Read file as Base64 string
        const reader = new FileReader();
        reader.onload = () => {
            // Strip the metadata prefix (e.g., "data:image/png;base64,")
            this.fileBase64 = reader.result.split(',')[1]; 
        };
        reader.readAsDataURL(file);
    }

    async removeAttachment() {
        if (this.selectedExpenseId) {
            try {
                // Call Apex to delete the actual ContentDocument
                await deleteExpenseAttachment({ expenseId: this.selectedExpenseId });
                this.showToast('Deleted', 'File permanently removed from the record.', 'success');
            } catch (error) {
                this.showToast('Error', 'Failed to delete file from org.', 'error');
                console.error(error);
            }
        }
        this.removeAttachmentLocalOnly();
    }

    // ─── DELETE LOGIC ────────────────────────────────────────────────────────
    handleBtnDelete(e) {
        e.stopPropagation();
        this.pendingDeleteId = e.currentTarget.dataset.id;
        this.deleteType = 'entry';
        this.isDeleteConfirmOpen = true;
    }

    // Helper to just clear UI state
    removeAttachmentLocalOnly() {
        this.attachedFileName = '';
        this.fileBase64 = null;
    }
    
    // ✅ RESTORED Delete Expense trigger
    handleDeleteExpense(e) {
        e.stopPropagation();
        this.pendingDeleteId = e.currentTarget.dataset.id;
        this.deleteType = 'expense';
        this.isDeleteConfirmOpen = true;
    }

    cancelDelete() { this.isDeleteConfirmOpen = false; this.pendingDeleteId = null; }
    
    confirmDelete() {
        const id = this.pendingDeleteId;
        this.isDeleteConfirmOpen = false;
        this.pendingDeleteId = null;
        if (!id) return;
        const act = this.deleteType === 'expense' ? deleteExpense({ expenseId: id }) : deleteTimeEntry({ entryId: id });
        act.then(() => {
            this.showToast('Deleted', 'Record removed.', 'success');
            return refreshApex(this.wiredResult);
        }).catch(err => this.showToast('Error', err.body?.message, 'error'));
    }

    // ─── UI HOVERS & UTILS ───────────────────────────────────────────────────
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
            this.hoverCard = {
                visible: true,
                style: `left:${Math.max(8, l)}px;top:${Math.max(8, t)}px;`,
                headerStyle: `background:${c.border};color:#fff;padding:10px 12px;`,
                description: en.Additional_Comments__c || en.Shift_Type__c || 'Time Entry',
                timeRange: (en.Start_Time__c && en.End_Time__c) ? `${TimeUtils.formatTime12h(en.Start_Time__c)} – ${TimeUtils.formatTime12h(en.End_Time__c)}` : '—',
                hours: (parseFloat(en.Hours_Worked_Number_Format__c) || 0).toFixed(1),
                displayDate: en.Date__c ? new Date(en.Date__c + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '',
                projectName: pr?.Project__r?.Name || 'Unknown Project',
                taskType: en.Shift_Type__c || '—',
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

    pushToUndoStack(type, rec) {
        this.actionHistory = [...this.actionHistory, { type, record: { ...rec } }];
        this.isUndoDisabled = false;
    }
    handleUndo() {
        if (!this.actionHistory.length) return;
        const last = this.actionHistory.pop();
        this.isUndoDisabled = this.actionHistory.length === 0;
        if (last.type === 'MOVE') {
            const r = last.record, n = TimeUtils.normalizeTime(r.Start_Time__c);
            const [sH, sM] = n ? n.split(':').map(Number) : [9, 0];
            const pr = this.allProjectResources.find(p => p.Project__c === r.Project__c);
            if (!pr) return;
            moveTimeEntry({
                entryId: r.Id, newProjectResourceId: pr.Id, newProjectId: r.Project__c,
                newDate: r.Date__c, startHour: sH, startMinute: sM
            }).then(() => refreshApex(this.wiredResult)).catch(() => {
                this.actionHistory.push(last);
                this.isUndoDisabled = false;
            });
        }
    }

    showToast(t, m, v) { this.dispatchEvent(new ShowToastEvent({ title: t, message: m, variant: v })); }
    stopPropagation(e) { e.stopPropagation(); }
    preventDrag(e) { e.preventDefault(); e.stopPropagation(); }
    handleEntryProjectChange(e) { this.entryProjectId = e.detail.value; }
    handleInputChange(e) {
        const v = e.detail?.value !== undefined ? e.detail.value : e.target?.value;
        if (v !== undefined) this[e.target.name] = v;
    }
}
