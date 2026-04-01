import { LightningElement, api, track } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';

export default class AssignExtendWizard extends LightningElement {
    @api recordId; // The Placement ID

    @track isStep1 = true;
    @track isStep2 = false;

    // Memory to hold data between steps
    capturedProjectId;
    capturedStartDate;
    capturedEndDate;

    // Fired when c-assign-project finishes its overlap check and clicks "Next"
    handleProjectAssigned(event) {
        // Grab the payload sent from the child component
        this.capturedProjectId = event.detail.projectId;
        this.capturedStartDate = event.detail.startDate;
        this.capturedEndDate = event.detail.endDate;

        // Move to Step 2
        this.isStep1 = false;
        this.isStep2 = true;
    }

    goBackToStep1() {
        this.isStep2 = false;
        this.isStep1 = true;
    }

    // Fired when c-create-deal-sheet-action successfully saves to the database
    handleWizardComplete() {
        this.dispatchEvent(new CloseActionScreenEvent());
        // You could also show a success toast here or refresh the view!
    }
}