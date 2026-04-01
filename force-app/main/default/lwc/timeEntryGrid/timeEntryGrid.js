import { LightningElement, api, track } from 'lwc';
import getData from '@salesforce/apex/TimeEntryController.getData';
import submitEntries from '@salesforce/apex/TimeEntryController.submitEntries';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

export default class TimeEntryGrid extends LightningElement {
    @api recordId;
    @track rows = [];
    @track isLocked = false; 
    @track taskOptions = []; // Holds the dynamic tasks for the combobox
    tsData; 
    
    shiftOptions = [
        { label: 'Regular', value: 'Regular' },
        { label: 'Overtime', value: 'Overtime' },
        { label: 'Double Time', value: 'Double Time' }
    ];

    connectedCallback() {
        this.loadData();
    }

    loadData() {
        getData({ tsId: this.recordId }).then(data => {
            this.tsData = data.ts;
            
            // Build the Task Dropdown Options
            if (data.tasks && data.tasks.length > 0) {
                this.taskOptions = data.tasks.map(t => {
                    return { label: t.Name, value: t.Id };
                });
            }

            // Lock UI if already processed
            if(this.tsData.Status__c === 'Submitted' || this.tsData.Status__c === 'Approved') {
                this.isLocked = true;
            } else {
                this.buildRows(this.tsData, data.entries);
            }
        }).catch(err => {
            this.showToast('Error loading data', err.body?.message || err.message, 'error');
        });
    }

    buildRows(ts, entries) {
        // Fix standard JS timezone shift when iterating dates
        let current = new Date(ts.Start_Date__c);
        current = new Date(current.getTime() + current.getTimezoneOffset() * 60000);
        
        let end = new Date(ts.End_Date__c);
        end = new Date(end.getTime() + end.getTimezoneOffset() * 60000);

        let tempRows = [];

        while (current <= end) {
            // Format YYYY-MM-DD
            let dateStr = current.getFullYear() + '-' + String(current.getMonth() + 1).padStart(2, '0') + '-' + String(current.getDate()).padStart(2, '0');
            let match = entries.find(e => e.Date__c === dateStr) || {};
            
            tempRows.push({
                Id: match.Id,
                date: dateStr,
                dayName: current.toLocaleDateString('en-US', { weekday: 'short' }),
                startTime: match.Start_Time__c || null,
                endTime: match.End_Time__c || null,
                breakTime: match.Break_Time__c || '',
                hours: match.Hours_Worked_Number_Format__c || '',
                shift: match.Shift_Type__c || 'Regular',
                taskId: match.Task__c || '',
                comments: match.Additional_Comments__c || ''
            });
            current.setDate(current.getDate() + 1); 
        }
        this.rows = tempRows;
    }

    handleChange(e) {
        let datasetId = e.target.dataset.id;
        let row = this.rows.find(r => r.date === datasetId);
        if(row) {
            row[e.target.name] = e.target.value;
        }
    }

    handleSubmit() {
        // Filter out completely blank rows
        const toSave = this.rows.filter(r => r.hours || (r.startTime && r.endTime)).map(r => {
            
            // Construct the sObject payload
            let entry = {
                sobjectType: 'Time_Entry__c',
                Timesheet__c: this.recordId,
                Date__c: r.date,
                Shift_Type__c: r.shift,
                Project_Resource__c: this.tsData.Project_Resource__c,
                Project__c: this.tsData.Project_Resource__r?.Project__c,
                Contact__c: this.tsData.Project_Resource__r?.Candidate_Employee__c
            };

            // Map all the granular fields explicitly
            if (r.Id) entry.Id = r.Id;
            if (r.taskId) entry.Task__c = r.taskId;
            if (r.comments) entry.Additional_Comments__c = r.comments;
            if (r.hours) entry.Hours_Worked_Number_Format__c = parseFloat(r.hours);
            if (r.breakTime) entry.Break_Time__c = parseFloat(r.breakTime);
            if (r.startTime) entry.Start_Time__c = r.startTime;
            if (r.endTime) entry.End_Time__c = r.endTime;

            return entry;
        });

        if (toSave.length === 0) {
            this.showToast('No Data', 'Please enter time before submitting.', 'warning');
            return;
        }

        submitEntries({ tsId: this.recordId, entries: toSave })
            .then(() => {
                this.showToast('Success', 'Your time entries have been submitted.', 'success');
                this.isLocked = true; 
                eval("$A.get('e.force:refreshView').fire();"); 
            })
            .catch(err => {
                this.showToast('Error', err.body?.message || err.message, 'error');
            });
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}