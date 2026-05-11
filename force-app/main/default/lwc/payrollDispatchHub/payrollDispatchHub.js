import { LightningElement, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

import getTrackedPayroll from '@salesforce/apex/PayrollConsoleController.getTrackedPayroll';
import markPayrollAsPaid from '@salesforce/apex/PayrollConsoleController.markPayrollAsPaid';

const TRACKED_ACTIONS = [
    { label: 'View PDF Archive', name: 'view_pdf' },
    { label: 'Mark as Paid', name: 'mark_paid' }
];

export default class PayrollDispatchHub extends NavigationMixin(LightningElement) {
    @track isLoading = true;
    @track allTrackedData = [];
    @track filteredTrackedData = [];

    trackedColumns = [
        { label: 'Payroll #', fieldName: 'Name', type: 'text', initialWidth: 140 },
        { label: 'Candidate', fieldName: 'candidateName', type: 'text' },
        { label: 'Generated On', fieldName: 'generatedDate', type: 'date', 
            typeAttributes: { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }, initialWidth: 160 },
        { label: 'Due Date', fieldName: 'dueDate', type: 'date-local', initialWidth: 120 },
        { label: 'Total Amount', fieldName: 'totalAmount', type: 'currency', initialWidth: 140 },
        { label: 'Net Pay', fieldName: 'totalAmount', type: 'currency', initialWidth: 140 },
        { label: 'Status', fieldName: 'status', type: 'text', initialWidth: 100, cellAttributes: { class: { fieldName: 'statusColor' } } },
        { type: 'action', typeAttributes: { rowActions: TRACKED_ACTIONS } }
    ];
    // --- PAGINATION STATE ---
    @track currentPage = 1;
    @track pageSize = 10; // Defaulting to 10!

    get hasData() { return this.filteredTrackedData && this.filteredTrackedData.length > 0; }

    get totalPages() { return Math.max(1, Math.ceil((this.filteredTrackedData?.length || 0) / this.pageSize)); }
    get isFirstPage() { return this.currentPage === 1; }
    get isLastPage() { return this.currentPage >= this.totalPages; }
    get pageInfo() { return `Page ${this.currentPage} of ${this.totalPages}`; }

    // 🌟 NEW: Dynamic Range Text (e.g. "Showing 1-10 of 45")
    get recordRangeInfo() {
        const total = this.filteredTrackedData ?.length || 0;
        if (total === 0) return '0 Records';
        const start = ((this.currentPage - 1) * this.pageSize) + 1;
        const end = Math.min(this.currentPage * this.pageSize, total);
        return `Showing ${start}-${end} of ${total}`;
    }

    get paginatedData() {
        if (!this.filteredTrackedData || this.filteredTrackedData.length === 0) return [];
        const start = (this.currentPage - 1) * this.pageSize;
        return this.filteredTrackedData.slice(start, start + this.pageSize);
    }

    handleNext() { if (!this.isLastPage) this.currentPage++; }
    handlePrev() { if (!this.isFirstPage) this.currentPage--; }

    // 🌟 NEW: Instantly resize and reset the page
    handlePageSizeChange(event) {
        this.pageSize = parseInt(event.target.value, 10);
        this.currentPage = 1;
    }

    connectedCallback() { this.loadAllData(); }

    loadAllData() {
        this.isLoading = true;
        
        getTrackedPayroll()
            .then(result => {
                this.allTrackedData = (result || []).map(row => {
                    let pillClass = 'saas-pill pill-neutral';
                    if (row.status === 'Paid') pillClass = 'saas-pill pill-success';
                    if (row.status === 'Overdue') pillClass = 'saas-pill pill-danger';
                    if (row.status === 'Sent') pillClass = 'saas-pill pill-warning';
                    return { ...row, pillClass };
                });
                this.filteredTrackedData = [...this.allTrackedData];
            })
            .catch(error => {
                this.showToast('Error Loading Data', error.body?.message || error.message, 'error');
            })
            .finally(() => {
                this.isLoading = false;
            });
    }

    handleTrackedSearch(event) {
        const term = event.target.value.toLowerCase();
        this.filteredTrackedData = this.allTrackedData.filter(row => 
            row.candidateName?.toLowerCase().includes(term) || row.Name?.toLowerCase().includes(term) || row.status?.toLowerCase().includes(term)
        );
        this.currentPage = 1;
    }

    handleActionClick(event) {
        const actionName = event.currentTarget.dataset.action;
        const recordId = event.currentTarget.dataset.id;
        const row = this.allTrackedData.find(r => r.Id === recordId);
        
        if (!row) return;

        if (actionName === 'view_pdf') {
            if (row.fileId) {
                this[NavigationMixin.Navigate]({
                    type: 'standard__namedPage',
                    attributes: { pageName: 'filePreview' },
                    state: { recordIds: row.fileId, selectedRecordId: row.fileId }
                });
            } else {
                this.showToast('Not Available', 'PDF document not found for this payroll.', 'info');
            }
        } else if (actionName === 'mark_paid') {
            this.isLoading = true;
            markPayrollAsPaid({ payrollKey: row.Id })
                .then(message => {
                    this.showToast('Payment Applied', message, 'success');
                    this.loadAllData(); 
                })
                .catch(error => {
                    this.showToast('Payment Failed', error.body?.message || error.message, 'error');
                    this.isLoading = false;
                });
        }
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
