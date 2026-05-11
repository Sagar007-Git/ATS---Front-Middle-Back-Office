import { LightningElement, track } from 'lwc';

export default class InvoiceEntityDashboard extends LightningElement {
    @track activeView = 'invoice-gen'; 

    get isInvoiceGen() { return this.activeView === 'invoice-gen'; }
    get isInvoiceHistory() { return this.activeView === 'invoice-history'; }
    get isPayrollGen() { return this.activeView === 'payroll-gen'; }
    get isPayrollHistory() { return this.activeView === 'payroll-history'; }

    get navInvoiceGenCss() { return this.activeView === 'invoice-gen' ? 'nav-item active' : 'nav-item'; }
    get navInvoiceHistoryCss() { return this.activeView === 'invoice-history' ? 'nav-item active' : 'nav-item'; }
    get navPayrollGenCss() { return this.activeView === 'payroll-gen' ? 'nav-item active' : 'nav-item'; }
    get navPayrollHistoryCss() { return this.activeView === 'payroll-history' ? 'nav-item active' : 'nav-item'; }

    handleNavSelect(event) {
        this.activeView = event.currentTarget.dataset.id;
    }
}