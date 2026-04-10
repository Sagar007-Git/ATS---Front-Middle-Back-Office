import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { NavigationMixin } from 'lightning/navigation';
import { CloseActionScreenEvent } from 'lightning/actions';
import { FlowNavigationNextEvent } from 'lightning/flowSupport';

// Apex Service
import getActionConfiguration from '@salesforce/apex/PrxmDynamicActionCtrl.getActionConfiguration';

export default class PrxmDynamicRecordCreator extends NavigationMixin(LightningElement) {
    // --- PUBLIC PROPERTIES ---
    // Use a setter so we can react to `recordId` changes (robust when parent updates after initialization)
    _recordId = null;
    _lastFetchKey = null;
    _initFetchDone = false;
    _isFetching = false;
    _needRefetch = false;

    @api
    get recordId() {
        return this._recordId;
    }
    set recordId(value) {
        this._recordId = value;
        // If the source key changed, trigger a refetch. Handle race where recordId
        // may be set while a fetch is already in-flight by deferring a second fetch.
        const newKey = `${this.actionName || ''}::${this._recordId || ''}`;
        if (newKey !== this._lastFetchKey) {
            if (this._isFetching) {
                this._needRefetch = true;
            } else {
                this.fetchConfiguration();
            }
        }
    }

    @api actionName;            // Configured by the Admin in App Builder or Flow
    @api availableActions = []; // Provided by Flow to check contextual navigation capabilities

    // --- WIZARD / WRAPPER PROPERTIES ---
    @api disableAutoClose = false;    // Prevents automatic closing/navigation (for multi-step wizards)
    @api defaultFieldOverrides = {};  // Object mapping API names to override values: { 'Placement__c': 'a01...', etc. }
    
    // ✅ NEW: Properties to handle multi-step UI tracking
    @api wizardSteps = [];            // Array of step objects: [{label: 'Step 1', value: '1'}, ...]
    @api currentStepValue;            // The value of the active step: '1', '2', etc.

    // --- STATE PROPERTIES ---
    @track config;       // Holds the decoded DTO
    @track isLoading = true;
    @track fatalErrorMessage = '';
    
    // --- GETTERS ---
    
    // ✅ NEW: Tells the HTML whether to draw the progress bar or not
    get hasWizardSteps() {
        return this.wizardSteps && this.wizardSteps.length > 0;
    }

    get isFormReady() {
        return this.config && !this.fatalErrorMessage;
    }

    get visibleFields() {
        if (!this.config?.fields) return [];
        // Filter out hidden fields from the UI - these will be injected logically
        return this.config.fields.filter(f => !f.isHidden);
    }

    // Groups visible fields by Section_Name__c for standard Salesforce UI rendering
    get formSections() {
        if (!this.visibleFields.length) return [];
        
        const grouped = {};
        this.visibleFields.forEach(f => {
            const secName = f.sectionName || 'General Information';
            if (!grouped[secName]) {
                grouped[secName] = { id: secName, name: secName, fields: [] };
            }
            grouped[secName].fields.push(f);
        });
        
        return Object.values(grouped);
    }

    get hiddenFields() {
        if (!this.config?.fields) return [];
        // Capture background mapped data to inject on submit
        return this.config.fields.filter(f => f.isHidden);
    }

    // --- LIFECYCLE ---
    connectedCallback() {
        // Wait until actionName is provided by the framework to avoid false errors
        if (!this.actionName) {
            // We return quietly here; the recordId setter or a later framework push will trigger it.
            // (Removed the immediate fatal error throw to prevent race conditions).
            return;
        }
        this.fetchConfiguration();
    }

    // --- MAIN ENGINE (Separation of concern from Lifecycle) ---
    async fetchConfiguration() {
        if (!this.actionName) return;

        this.isLoading = true;
        this.fatalErrorMessage = '';
        this._isFetching = true;
        const fetchKey = `${this.actionName || ''}::${this.recordId || ''}`;

        try {
            console.log('PrxmDynamicRecordCreator.fetchConfiguration - calling Apex', { actionName: this.actionName, sourceRecordId: this.recordId });

            let responseData = await getActionConfiguration({
                actionName: this.actionName,
                sourceRecordId: this.recordId || null
            });

            console.log('PrxmDynamicRecordCreator.fetchConfiguration - Apex response', responseData);
            
            if (responseData.fields) {
                responseData.fields.forEach(field => {
                    // ✅ THE FIX: SANITIZE IMMEDIATELY ON LOAD
                    // If Apex hands us a Number, force it to be a String before the HTML ever sees it!
                    if (typeof field.defaultValue === 'number') {
                        field.defaultValue = field.defaultValue.toString();
                    }

                    // Apply Parent Overrides (and sanitize them too!)
                    if (this.defaultFieldOverrides && this.defaultFieldOverrides.hasOwnProperty(field.apiName)) {
                        let overrideVal = this.defaultFieldOverrides[field.apiName];
                        field.defaultValue = (typeof overrideVal === 'number') ? overrideVal.toString() : overrideVal;
                    }
                });
            }

            this.config = responseData;
            this._lastFetchKey = fetchKey;
            this._initFetchDone = true;
            this.isLoading = false;
            this._isFetching = false;

            if (this._needRefetch) {
                this._needRefetch = false;
                await this.fetchConfiguration();
            }

        } catch (error) {
            this.isLoading = false;
            this._isFetching = false;
            const msg = error.body ? error.body.message : error.message;
            this.handleFatalError(msg);
            this.showToast('Configuration Failure', msg, 'error', 'sticky');
        }
    }

    // --- FORM EVENTS ---
    
    handleSave(event) {
        event.preventDefault(); // Stop standard button click behavior just in case
        
        const form = this.refs.editForm;
        if (form) {
            form.submit(); // This will automatically trigger handleFormSubmit()
        }
    }

    /**
     * Intercepts the form submission to inject hidden field logic, sanitize types, and validate
     */
    handleFormSubmit(event) {
        event.preventDefault(); 
        this.isLoading = true;  

        const payloadFields = { ...event.detail.fields };

        // 1. Inject Hidden Fields
        this.hiddenFields.forEach(hiddenField => {
            if (hiddenField.defaultValue !== undefined && hiddenField.defaultValue !== null) {
                payloadFields[hiddenField.apiName] = hiddenField.defaultValue; 
            }
        });

        // 2. Inject Read-Only Fields
        this.visibleFields.forEach(visibleField => {
            if (visibleField.isReadOnly && visibleField.defaultValue !== undefined && visibleField.defaultValue !== null) {
                payloadFields[visibleField.apiName] = visibleField.defaultValue;
            }
        });

        const fieldTypeMap = new Map(
            (this.config?.fields || []).map(f => [f.apiName, f])
        );

        Object.keys(payloadFields).forEach(key => {
            const fieldConfig = fieldTypeMap.get(key);
            const isTextField = fieldConfig && 
                ['String', 'TextArea', 'Phone', 'Email', 'Url'].includes(fieldConfig.dataType);
            
            if (typeof payloadFields[key] === 'number' && isTextField) {
                payloadFields[key] = payloadFields[key].toString();
            }
        });

        // 4. Submit
        try {
            this.refs.editForm.submit(payloadFields);
        } catch(err) {
            this.isLoading = false;
            console.error('Submit execution error:', err);
            this.showToast('Validation Error', 'Failed to process payload for submission.', 'error');
        }
    }

    /**
     * Successfully committed to the database
     */
    handleFormSuccess(event) {
    this.isLoading = false;
    const newRecordId = event.detail.id;

    // ✅ FIX: Enable bubbling so parent components can listen
    this.dispatchEvent(new CustomEvent('savecomplete', { 
        detail: { recordId: newRecordId },
        bubbles: true,        // ← Critical
        composed: true        // ← Critical for crossing Shadow DOM
    }));

    if (!this.disableAutoClose) {
        this.showToast('Success', 'Record created successfully!', 'success');
        this.navigateAndClose(newRecordId);
    }
}

    /**
     * Standard LDS Form failed to save (e.g., Validation Rule, missing Required field)
     */
    handleFormError(event) {
        this.isLoading = false;
        
        // Extract exact validation rule or system error from standard UI API structure
        const errorDetail = event.detail.detail || event.detail.message || 'An unknown error occurred during save.';
        
        console.error('Lightning Data Service Error:', errorDetail);
        this.showToast('Save Failed', errorDetail, 'error', 'sticky');
    }

    // --- UTILITIES ---

    handleFatalError(message) {
        this.fatalErrorMessage = message;
        console.error('Prxm Dynamic Engine Error: ', message);
    }

    handleCancel() {
        this.closeAction();
    }

    navigateAndClose(newRecordId) {
        // 1. Navigate to the new record
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId: newRecordId,
                objectApiName: this.config.targetObjectApiName,
                actionName: 'view' // redirect
            }
        });

        // 2. Close contextual popups (Flow or Quick Action)
        this.closeAction();
    }

    closeAction() {
        // If housed in a Quick Action
        this.dispatchEvent(new CloseActionScreenEvent());

        // If housed in a Screen Flow
        if (this.availableActions.find((action) => action === 'NEXT')) {
            this.dispatchEvent(new FlowNavigationNextEvent());
        }
    }

    showToast(title, message, variant, mode = 'dismissible') {
        const toastEvent = new ShowToastEvent({
            title: title,
            message: message,
            variant: variant,
            mode: mode
        });
        this.dispatchEvent(toastEvent);
    }
}