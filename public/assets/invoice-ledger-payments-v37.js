
(function(){
  if(window.__wipkoV37Payments)return; window.__wipkoV37Payments=true;
  function num(v){var x=Number(v);return Number.isFinite(x)?x:0}
  function r2(v){return Math.round((num(v)+Number.EPSILON)*100)/100}
  function paymentSum(inv){return r2((inv.payments||[]).reduce(function(s,p){return s+num(p.amount)},0))}
  function syncInvoice(inv){
    if(!inv)return;
    if(inv.manualPaidAmount===undefined){inv.manualPaidAmount=(inv.payments&&inv.payments.length)?0:num(inv.amountPaid)}
    var paid=r2(num(inv.manualPaidAmount)+paymentSum(inv));
    var total=num(inv.total||inv.grandTotal||inv.invoiceTotal);
    inv.amountPaid=paid;
    inv.balanceAmount=Math.max(r2(total-paid),0);
    inv.payStatus=inv.paymentStatus=inv.balanceAmount<=0.009?'Paid':paid>0?'Partial':'Pending';
    var ps=(inv.payments||[]).filter(function(p){return p.date}).sort(function(a,b){return String(b.date).localeCompare(String(a.date))});
    inv.paidDate=ps.length?ps[0].date:(inv.paidDate||'');
  }
  window.invoicePaidAmount=function(inv){
    if(!inv)return 0;
    if(inv.manualPaidAmount===undefined && !(inv.payments||[]).length)return num(inv.amountPaid);
    return r2(num(inv.manualPaidAmount)+paymentSum(inv));
  };
  window.invoiceDueAmount=function(inv){return Math.max(r2(num(inv&&inv.total)-window.invoicePaidAmount(inv)),0)};

  function makeMoneyInputsDecimal(root){
    (root||document).querySelectorAll('input[type="number"]').forEach(function(el){
      var key=((el.name||'')+' '+(el.placeholder||'')+' '+((el.closest('label')||{}).textContent||'')).toLowerCase();
      if(/amount|vat|rate|price|cost|income|expense|paid|balance|total|discount|allowance|deduction|salary|budget|value/.test(key)){
        el.step='0.01';
        el.inputMode='decimal';
      }
    });
  }

  function allocationData(form){
    return Array.from(form.querySelectorAll('.ledger-allocation-input')).map(function(x){return {kind:x.dataset.kind,id:x.dataset.recordId,amount:r2(x.value)}}).filter(function(x){return x.amount>0});
  }
  function removeLedgerPayments(ledgerId){
    (db.invoices||[]).forEach(function(inv){inv.payments=(inv.payments||[]).filter(function(p){return p.ledgerId!==ledgerId});syncInvoice(inv)});
    (db.purchaseBills||[]).forEach(function(b){b.payments=(b.payments||[]).filter(function(p){return p.ledgerId!==ledgerId})});
  }
  function applyInvoicePayment(ledger,allocs){
    if(!ledger)return;
    removeLedgerPayments(ledger.id);
    var applied=[];
    allocs.forEach(function(a){
      if(a.kind!=='invoice')return;
      var inv=(db.invoices||[]).find(function(i){return i.id===a.id}); if(!inv)return;
      syncInvoice(inv);
      var amt=Math.min(r2(a.amount),window.invoiceDueAmount(inv)); if(amt<=0)return;
      inv.payments=inv.payments||[];
      inv.payments.push({ledgerId:ledger.id,amount:amt,date:ledger.date||today(),mode:ledger.category||'Ledger',reference:ledger.desc||'',user:(user&&user.username)||'system'});
      syncInvoice(inv);
      applied.push({kind:'invoice',id:inv.id,invoiceNo:inv.no||'',amount:amt,date:ledger.date||today()});
    });
    ledger.allocations=applied;
    ledger.linkedInvoiceIds=applied.map(function(a){return a.id});
    ledger.allocatedAmount=r2(applied.reduce(function(s,a){return s+a.amount},0));
    var amt=num(ledger.amount);
    ledger.payStatus=ledger.allocatedAmount>=amt-0.009?'Paid':ledger.allocatedAmount>0?'Partial':(ledger.payStatus||'Pending');
  }

  var oldSave=window.saveCrud;
  window.saveCrud=async function(e,col){
    if(col!=='accounts')return oldSave.apply(this,arguments);
    var form=e&&e.target;
    var existingId=form&&form.elements.id&&form.elements.id.value;
    var type=form&&form.elements.type&&form.elements.type.value;
    var allocs=form?allocationData(form):[];
    var before=new Set((db.accounts||[]).map(function(a){return a.id}));
    var result=await oldSave.apply(this,arguments);
    var ledger=existingId?(db.accounts||[]).find(function(a){return a.id===existingId}):(db.accounts||[]).find(function(a){return !before.has(a.id)});
    if(ledger&&type==='Income'){
      applyInvoicePayment(ledger,allocs);
      try{save()}catch(err){}
      try{render()}catch(err){}
    }
    return result;
  };

  window.v37PayInvoice=function(invoiceId){
    var inv=(db.invoices||[]).find(function(i){return i.id===invoiceId});
    if(!inv)return alert('Invoice not found.');
    syncInvoice(inv);
    if(window.invoiceDueAmount(inv)<=0.009)return alert('This invoice is already fully paid.');
    openPage('accounts');
    setTimeout(function(){
      if(typeof v69OpenDrawer==='function')v69OpenDrawer('accounts');
      setTimeout(function(){
        var drawer=document.getElementById('drawer-accounts');
        var f=drawer&&drawer.querySelector('form'); if(!f)return alert('Ledger form is not available.');
        if(f.elements.type){f.elements.type.value='Income';f.elements.type.dispatchEvent(new Event('change',{bubbles:true}))}
        setTimeout(function(){
          if(f.elements.party){f.elements.party.value=inv.client;f.elements.party.dispatchEvent(new Event('change',{bubbles:true}))}
          if(f.elements.date)f.elements.date.value=today();
          if(f.elements.desc)f.elements.desc.value='Payment received for '+(inv.no||'Invoice');
          if(f.elements.payStatus)f.elements.payStatus.value='Paid';
          setTimeout(function(){
            var input=f.querySelector('.ledger-allocation-input[data-record-id="'+invoiceId+'"]');
            if(input){input.value=window.invoiceDueAmount(inv).toFixed(2);input.dispatchEvent(new Event('input',{bubbles:true}))}
            else if(f.elements.amount)f.elements.amount.value=window.invoiceDueAmount(inv).toFixed(2);
            makeMoneyInputsDecimal(f);
            var amt=f.elements.amount;if(amt){amt.focus();amt.select()}
          },180);
        },80);
      },80);
    },40);
  };

  var oldInvoicePage=window.invoicePage;
  window.invoicePage=function(){
    (db.invoices||[]).forEach(syncInvoice);
    var html=oldInvoicePage.apply(this,arguments);
    html=html.replace(/(<button class="mini" title="Invoice Info"[^>]*onclick="event\.stopPropagation\(\);openInvoicePopup\('([^']+)'\)"[^>]*>ⓘ<\/button>)/g,function(all,info,id){
      return '<button class="mini invoice-pay-btn-v37" title="Record Payment" onclick="event.stopPropagation();v37PayInvoice(\''+id+'\')">💳 Pay</button>'+info;
    });
    return html;
  };

  var oldRender=window.render;
  window.render=function(){var r=oldRender.apply(this,arguments);setTimeout(function(){makeMoneyInputsDecimal(document.getElementById('workspace')||document)},20);return r};
  document.addEventListener('focusin',function(e){if(e.target&&e.target.matches('input[type="number"]'))makeMoneyInputsDecimal(e.target.form||document)});
  (db.invoices||[]).forEach(syncInvoice);
  try{save()}catch(e){}
})();
