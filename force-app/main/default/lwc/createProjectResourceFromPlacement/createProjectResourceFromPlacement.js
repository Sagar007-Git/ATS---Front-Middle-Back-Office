import { LightningElement, api, track } from 'lwc';
import fetchOverrides from '@salesforce/apex/PrxmProjectResourceFromPlacementCtrl.getProjectOverrides';
import { CloseActionScreenEvent } from 'lightning/actions';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { NavigationMixin } from 'lightning/navigation'; // ✅ Added missing Navigation

export default class CreateProjectResourceFromPlacement extends NavigationMixin(LightningElement) {
    @api recordId; // Implicitly injected: This is the Placement Record ID
    
    @api invoke() {
        console.log('Invoked with Placement recordId', this.recordId);
    }

    // --- STATE TRACKING ---
    @track step = 1; // ✅ Simplified to a single numeric step tracker (1 = Project, 2 = Resource)
    @track selectedProjectId = null;
    @track defaultOverrides = null;

    // --- CONFIGURATION ---
    wizardSteps = [
        { label: 'Select Project', value: '1' },
        { label: 'Create Project Resource', value: '2' }
    ];

    // --- GETTERS ---
    get isStepSelectProject() {
        return this.step === 1;
    }

    get isStepCreateResource() {
        return this.step === 2;
    }

    // ==========================================
    // WIZARD STEP HANDLERS
    // ==========================================

    handleProjectChange(event) {
        this.selectedProjectId = event.detail.recordId;
    }

    /**
     * Step 1: Validates selection and fetches data overrides before moving to Step 2
     */
    handleNext() {
        // Validate Project Selection
        if (!this.selectedProjectId) {
            this.showToast('Required', 'Please select a Project before continuing.', 'error');
            return;
        }

        // Fetch custom mapped overrides from Apex
        fetchOverrides({ placementId: this.recordId, projectId: this.selectedProjectId })
            .then(result => {
                // ✅ Combine the Apex results WITH our known Placement and Project IDs
                this.defaultOverrides = {
                    ...result,
                    'Placement__c': this.recordId, 
                    'Project__c': this.selectedProjectId
                };
                
                // Advance to Step 2
                this.step = 2;
            })
            .catch(error => {
                console.error('Error fetching overrides:', error);
                const msg = error.body ? error.body.message : error.message || 'Failed to fetch configuration.';
                this.showToast('Error', msg, 'error', 'sticky');
            });
    }

    /**
     * Step 2: Triggered when the Project Resource is successfully saved
     */
    handleResourceSaved(event) {
        const newRecordId = event.detail?.recordId;

        if (!newRecordId) {
            this.showToast('Error', 'Failed to capture the new Project Resource ID.', 'error');
            return;
        }

        this.showToast('Success', 'Project Resource assigned successfully!', 'success');
        
        // ✅ Navigate to the newly created record and close the quick action modal
        this.navigateToRecord(newRecordId);
        this.closeQuickAction();
    }

    // ==========================================
    // UTILITY METHODS
    // ==========================================

    /**
     * Standardized Toast Notification Method
     */
    showToast(title, message, variant, mode = 'dismissible') {
        this.dispatchEvent(new ShowToastEvent({
            title: title,
            message: message,
            variant: variant,
            mode: mode
        }));
    }

    /**
     * Standardized Record Navigation Method
     */
    navigateToRecord(recordIdToView) {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId: recordIdToView,
                actionName: 'view'
            }
        });
    }

    /**
     * Cleanly closes the Quick Action modal
     */
    closeQuickAction() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}