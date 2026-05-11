import { LightningElement, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getConsolidatedPayroll from '@salesforce/apex/PayrollConsoleController.getConsolidatedPayroll';
import executeMasterPayrollRun from '@salesforce/apex/PayrollConsoleController.executeMasterPayrollRun';

export default class PayrollManagerHub extends NavigationMixin(LightningElement) {
    @track isLoading = false;
    @track hasSearched = false; // 🌟 NEW
    @track payrollStartDate = '';
    @track payrollEndDate = '';
    @track consolidatedCandidates = [];
    @track currentPage = 1;
    @track pageSize = 10;

    // 🌟 Dual States
    get hasPayrollData() { return this.consolidatedCandidates.length > 0; }
    get showInitialState() { return !this.hasSearched && !this.hasPayrollData; }
    get showNoResultsState() { return this.hasSearched && !this.hasPayrollData; }

    get totalPages() { return Math.max(1, Math.ceil((this.consolidatedClients?.length || 0) / this.pageSize)); }
    get isFirstPage() { return this.currentPage === 1; }
    get isLastPage() { return this.currentPage >= this.totalPages; }
    get pageInfo() { return `Page ${this.currentPage} of ${this.totalPages}`; }

    // 🌟 NEW: Dynamic Range Text (e.g. "Showing 1-10 of 45")
    get recordRangeInfo() {
        const total = this.consolidatedClients?.length || 0;
        if (total === 0) return '0 Records';
        const start = ((this.currentPage - 1) * this.pageSize) + 1;
        const end = Math.min(this.currentPage * this.pageSize, total);
        return `Showing ${start}-${end} of ${total}`;
    }

    get paginatedData() {
        if (!this.consolidatedClients || this.consolidatedClients.length === 0) return [];
        const start = (this.currentPage - 1) * this.pageSize;
        return this.consolidatedClients.slice(start, start + this.pageSize);
    }

    handleNext() { if (!this.isLastPage) this.currentPage++; }
    handlePrev() { if (!this.isFirstPage) this.currentPage--; }

    // 🌟 NEW: Instantly resize and reset the page
    handlePageSizeChange(event) {
        this.pageSize = parseInt(event.target.value, 10);
        this.currentPage = 1;
    }

    get selectedCount() { return this.consolidatedCandidates.filter(c => c.selected).length; }
    get hasSelectedCandidates() { return this.selectedCount > 0; }
    get isAllSelected() { return this.hasPayrollData && this.consolidatedCandidates.every(c => c.selected); }

    handleStartChange(e) { this.payrollStartDate = e.target.value; this.hasSearched = false; this.consolidatedCandidates = []; }
    handleEndChange(e) { this.payrollEndDate = e.target.value; this.hasSearched = false; this.consolidatedCandidates = []; }

    // --- SMART DATE QUICK SELECTORS (PAYROLL) ---
    handleQuickDate(event) {
        const range = event.currentTarget.dataset.range;
        const today = new Date();
        let start, end;

        if (range === 'thisMonth') {
            start = new Date(today.getFullYear(), today.getMonth(), 1);
            end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        } 
        else if (range === 'lastMonth') {
            start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            end = new Date(today.getFullYear(), today.getMonth(), 0);
        } 
        else if (range === 'thisQuarter') {
            const quarter = Math.floor(today.getMonth() / 3);
            start = new Date(today.getFullYear(), quarter * 3, 1);
            end = new Date(today.getFullYear(), quarter * 3 + 3, 0);
        }

        // 🌟 CRITICAL FIX: Extract local date explicitly to avoid UTC Timezone shifting (e.g., May 1st turning into April 30th)
        const formatLocal = (d) => {
            const yr = d.getFullYear();
            const mo = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${yr}-${mo}-${day}`;
        };

        // 🌟 CRITICAL FIX: Update the Payroll variables, not the Billing variables!
        this.payrollStartDate = formatLocal(start);
        this.payrollEndDate = formatLocal(end);

        // 🌟 CRITICAL FIX: Reset the Candidate array, not the Client array!
        this.hasSearched = false;
        this.consolidatedCandidates = [];
    }
    runConsolidation() {
        if (!this.payrollStartDate || !this.payrollEndDate) {
            this.showToast('Missing Parameters', 'Please select both a Start Date and an End Date.', 'warning');
            return;
        }

        this.isLoading = true;
        getConsolidatedPayroll({ startDate: this.payrollStartDate, endDate: this.payrollEndDate })
        .then(result => {
            this.consolidatedCandidates = result.map(c => ({ ...c, selected: false, rowClass: 'saas-grid-row' }));
            this.hasSearched = true;
            this.currentPage = 1;
        })
        .catch(error => this.showToast('Error', this.extractErrorMessage(error), 'error'))
        .finally(() => this.isLoading = false);
    }

    handleSelectAll(e) {
        const isChecked = e.target.checked;
        this.consolidatedCandidates = this.consolidatedCandidates.map(c => ({ ...c, selected: isChecked, rowClass: isChecked ? 'saas-grid-row selected' : 'saas-grid-row' }));
    }

    handleSelectCandidate(e) {
        const candId = e.target.dataset.id;
        const isChecked = e.target.checked;
        this.consolidatedCandidates = this.consolidatedCandidates.map(c => {
            if (c.candidateId === candId) return { ...c, selected: isChecked, rowClass: isChecked ? 'saas-grid-row selected' : 'saas-grid-row' };
            return c;
        });
    }

    previewPDF(e) {
        const candId = e.currentTarget.dataset.id;
        const url = `/apex/PxmPayrollPDF?candId=${candId}&startDate=${this.payrollStartDate}&endDate=${this.payrollEndDate}`;
        window.open(url, '_blank');
    }

    executeFinalization() {
        const selectedIds = this.consolidatedCandidates.filter(c => c.selected).map(c => c.candidateId);
        this.isLoading = true;
        executeMasterPayrollRun({ candidateIds: selectedIds, startDate: this.payrollStartDate, endDate: this.payrollEndDate })
        .then(message => {
            this.showToast('Batch Run Initiated', message, 'success');
            this.consolidatedCandidates = this.consolidatedCandidates.filter(c => !c.selected);
            if(this.consolidatedCandidates.length === 0) this.hasSearched = false;
        })
        .catch(error => this.showToast('Dispatch Blocked', this.extractErrorMessage(error), 'error'))
        .finally(() => this.isLoading = false);
    }

    extractErrorMessage(error) { return error.body?.message || error.message || 'Unknown error occurred.'; }
    showToast(title, message, variant) { this.dispatchEvent(new ShowToastEvent({ title, message, variant })); }
}