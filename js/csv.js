export function parseCsv(text) {
  const rows=[];let row=[],field='',quoted=false;
  const input=String(text||'').replace(/^\uFEFF/,'');
  for(let i=0;i<input.length;i++){
    const char=input[i];
    if(quoted){
      if(char==='"'&&input[i+1]==='"'){field+='"';i++;}
      else if(char==='"')quoted=false;
      else field+=char;
    } else if(char==='"')quoted=true;
    else if(char===','){row.push(field);field='';}
    else if(char==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}
    else field+=char;
  }
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
  return rows;
}

export function csvObjects(text) {
  const rows=parseCsv(text).filter(row=>row.some(cell=>cell.trim()));
  if(!rows.length)return [];
  const headers=rows[0].map(value=>value.trim());
  return rows.slice(1).map(row=>Object.fromEntries(headers.map((key,index)=>[key,row[index]??''])));
}
