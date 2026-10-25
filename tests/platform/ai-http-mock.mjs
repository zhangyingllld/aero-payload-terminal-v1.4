export const state = {calls:[],destroyed:0,response:null,error:null};
export function reset(){state.calls=[];state.destroyed=0;state.response={responseCode:200,result:JSON.stringify({ok:true,text:'已知事实：E1 结果未确认',model:'deepseek-flash',elapsedMs:123,simulated:true})};state.error=null;}
export const mockHttp={RequestMethod:{POST:'POST'},HttpDataType:{STRING:0},createHttp(){return{async request(url,options){state.calls.push({url,options});if(state.error)throw state.error;return state.response;},destroy(){state.destroyed++;}};}};
reset();
