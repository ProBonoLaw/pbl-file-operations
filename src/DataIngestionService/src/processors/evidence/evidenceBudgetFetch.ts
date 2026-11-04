import {EvidenceBudgetError, selectedEvidenceBudget, evidenceCostBudget,
  tokenCostMicros, type EvidenceCostBudget, type EvidenceBudgetPrice} from "./evidenceCostBudget.js";
import {isEvidenceContentFilter} from "./evidenceContentFilter.js";
import {currentEvidenceTaskCancellation} from "./evidenceAsync.js";

interface Target {deployment:string;provider:string}
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value==="object" && !Array.isArray(value);
const nonnegativeInteger = (value:unknown):value is number => typeof value==="number" && Number.isSafeInteger(value) && value>=0;
function blocked(error:unknown):Response {
  const failure=error instanceof EvidenceBudgetError ? error
    : new EvidenceBudgetError("evidence_budget_unavailable","Evidence request blocked because its durable cost bound could not be established");
  return new Response(JSON.stringify({error:{message:failure.message,type:"evidence_budget",code:failure.code}}),{
    status:402,headers:{"content-type":"application/json","x-should-retry":"false"},
  });
}
function usageCost(body:unknown,price:EvidenceBudgetPrice,inputBound:number,outputBound:number):number|null {
  if(!record(body))return null;
  if(price.kind==="router" && typeof body.model!=="string")return null;
  if(price.kind==="router" && typeof body.model==="string" &&
    body.model!==price.deployment && !price.allowedModels?.includes(body.model))
    throw new EvidenceBudgetError("evidence_budget_configuration","Router selected an unpriced model");
  if(!record(body.usage))return null;
  const input=price.kind==="embeddings"?body.usage.prompt_tokens:price.kind==="messages"
    ? [body.usage.input_tokens,body.usage.cache_creation_input_tokens,body.usage.cache_read_input_tokens]
      .every(nonnegativeInteger)
      ? (body.usage.input_tokens as number)+(body.usage.cache_creation_input_tokens as number)+(body.usage.cache_read_input_tokens as number)
      : null
    :body.usage.input_tokens;
  const output=price.kind==="embeddings"?0:body.usage.output_tokens;
  if(!nonnegativeInteger(input)||!nonnegativeInteger(output))return null;
  if(input>inputBound||output>outputBound)
    throw new EvidenceBudgetError("evidence_budget_configuration","Provider usage exceeded its configured token bound");
  let inputCost:number;
  if(price.kind==="messages") {
    const usage=body.usage as Record<string,number>;
    inputCost=tokenCostMicros(usage.input_tokens,price.uncachedInputUsdPerMillion??price.inputUsdPerMillion)
      +tokenCostMicros(usage.cache_creation_input_tokens,price.cacheWriteUsdPerMillion??price.inputUsdPerMillion)
      +tokenCostMicros(usage.cache_read_input_tokens,price.cacheReadUsdPerMillion??price.inputUsdPerMillion);
  } else if(price.kind==="embeddings") inputCost=tokenCostMicros(input,price.inputUsdPerMillion);
  else {
    const details=record(body.usage.input_tokens_details)?body.usage.input_tokens_details:null;
    const cached=details && nonnegativeInteger(details.cached_tokens)?details.cached_tokens:0;
    const written=details && nonnegativeInteger(details.cache_write_tokens)?details.cache_write_tokens:0;
    const fullyClassified=details && nonnegativeInteger(details.cached_tokens) && nonnegativeInteger(details.cache_write_tokens);
    if(cached+written>input)
      throw new EvidenceBudgetError("evidence_budget_configuration","Provider cache usage exceeded reported input tokens");
    inputCost=tokenCostMicros(input-cached-written,fullyClassified
      ?price.uncachedInputUsdPerMillion??price.inputUsdPerMillion:price.inputUsdPerMillion)
      +tokenCostMicros(cached,price.cacheReadUsdPerMillion??price.inputUsdPerMillion)
      +tokenCostMicros(written,price.cacheWriteUsdPerMillion??price.inputUsdPerMillion);
  }
  // Missing cache detail retains the input ceiling. Reasoning is already in output_tokens.
  // Independent category rounding can exceed the single full-price reservation by a microdollar.
  return Math.min(inputCost,tokenCostMicros(input,price.inputUsdPerMillion))
    +tokenCostMicros(output,price.outputUsdPerMillion)
    +(price.kind==="router"?tokenCostMicros(input,price.routerFeeUsdPerMillion!):0);
}

/** Intercept every actual SDK HTTP attempt, including tool rounds and SDK retries. */
export function budgetedEvidenceFetch(target:Target, transport:typeof fetch=fetch,
  suppliedBudget?:EvidenceCostBudget):typeof fetch {
  return async(input,init)=>{
    const taskControl=currentEvidenceTaskCancellation();
    await taskControl?.assertOpen();
    const requestSignal=init?.signal??(input instanceof Request?input.signal:undefined);
    const signal=taskControl ? AbortSignal.any([taskControl.signal,...(requestSignal?[requestSignal]:[])]) : requestSignal;
    const requestInit=taskControl ? {...init,signal} : init;
    let selection;
    try {selection=selectedEvidenceBudget();}
    catch(error){return blocked(error);}
    if(!selection)return transport(input,requestInit);
    let price:EvidenceBudgetPrice;
    let body:Record<string,unknown>;
    let inputBound:number, outputBound:number;
    let budget:EvidenceCostBudget;
    let reservation:string;
    let maximum:number;
    try {
      signal?.throwIfAborted();
      const url=new URL(input instanceof Request?input.url:String(input));
      const kind=url.pathname.endsWith("/responses")&&target.provider==="openai"?"responses"
        :url.pathname.endsWith("/embeddings")&&target.provider==="openai"?"embeddings"
          :url.pathname.endsWith("/messages")&&target.provider==="anthropic"?"messages":null;
      if(!kind)throw new EvidenceBudgetError("evidence_budget_configuration","Budgeted endpoint/protocol is not supported");
      const configured=selection.config.prices.filter(p=>p.origin===url.origin&&p.deployment===target.deployment&&
        (p.kind===kind||kind==="responses"&&p.kind==="router"));
      if(configured.length!==1)throw new EvidenceBudgetError("evidence_budget_configuration","No unique verified cost bound for this deployment");
      price=configured[0];
      const text=typeof init?.body==="string"?init.body:input instanceof Request?await input.clone().text():null;
      if(!text)throw new EvidenceBudgetError("evidence_budget_configuration","Budgeted request must have a JSON body");
      const parsed:unknown=JSON.parse(text);
      if(!record(parsed))throw new Error("Invalid request body");
      body=parsed;
      if(body.stream||body.background||body.n!==undefined&&body.n!==1||body.service_tier!==undefined&&body.service_tier!=="default")
        throw new EvidenceBudgetError("evidence_budget_configuration","Budget supports synchronous standard-tier requests only");
      if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(t=>!record(t)||
        (kind==="messages" ? typeof t.name!=="string"||!record(t.input_schema)||t.type!==undefined
          :t.type!=="function"))))
        throw new EvidenceBudgetError("evidence_budget_configuration","Provider-billed tools are outside the token cost bound");
      // Only text inputs are supported. Remote media, audio output and built-in
      // tools can introduce separate charges not bounded by these token prices.
      const media=(value:unknown):boolean=>Array.isArray(value)?value.some(media):record(value)
        ? typeof value.type==="string"&&/image|audio|video|file/.test(value.type)||Object.values(value).some(media):false;
      if(media(body.input)||media(body.messages)||media(body.system)||body.audio||body.modalities)
        throw new EvidenceBudgetError("evidence_budget_configuration","Budgeted evidence input must be text only");
      inputBound=price.maxInputTokens;
      outputBound=0;
      if(kind==="responses"||kind==="messages") {
        if(body.model!==target.deployment)throw new EvidenceBudgetError("evidence_budget_configuration","Request deployment changed");
        const requested=kind==="messages"?body.max_tokens:body.max_output_tokens;
        if(requested!==undefined&&(!nonnegativeInteger(requested)||!requested))throw new Error("Invalid output limit");
        outputBound=requested===undefined?price.maxOutputTokens:Math.min(requested as number,price.maxOutputTokens);
        if(kind==="messages") {
          if(!Array.isArray(body.messages)||!body.messages.length||body.inference_geo||body.speed)
            throw new EvidenceBudgetError("evidence_budget_configuration","Budgeted Anthropic request requires standard text messages");
          body.max_tokens=outputBound;
        } else body.max_output_tokens=outputBound;
      } else {
        const inputs=Array.isArray(body.input)?body.input:[body.input];
        if(!inputs.length||inputs.some(value=>typeof value!=="string"))throw new EvidenceBudgetError("evidence_budget_configuration","Budgeted embeddings require text inputs");
        const deploymentFromPath=/\/deployments\/([^/]+)\/embeddings$/.exec(url.pathname)?.[1];
        if(deploymentFromPath&&decodeURIComponent(deploymentFromPath)!==target.deployment)
          throw new EvidenceBudgetError("evidence_budget_configuration","Embedding deployment changed");
        if(!deploymentFromPath&&body.model!==target.deployment)
          throw new EvidenceBudgetError("evidence_budget_configuration","Embedding request must identify its priced deployment");
        inputBound*=inputs.length;
        if(!Number.isSafeInteger(inputBound))throw new Error("Embedding batch is too large");
      }
      // The JSON body contains every supplied text token. Allow ample room for
      // tokenization and provider framing without reserving an entire 1M-token
      // context for a short prompt. Server-side references can add unseen text.
      const serverSideContext=kind==="responses" &&
        (body.previous_response_id!==undefined||body.conversation!==undefined||body.prompt!==undefined)
        || kind==="messages" && body.container!==undefined;
      if(!serverSideContext)
        inputBound=Math.min(inputBound,Buffer.byteLength(JSON.stringify(body),"utf8")*2+65_536);
      maximum=tokenCostMicros(inputBound,price.inputUsdPerMillion)+tokenCostMicros(outputBound,price.outputUsdPerMillion)
        +(price.kind==="router"?tokenCostMicros(inputBound,price.routerFeeUsdPerMillion!):0);
      budget=suppliedBudget??evidenceCostBudget();
      reservation=await budget.reserve(selection,maximum);
    } catch(error){return blocked(error);}

    // A missing response is charged against the full reservation. Never assume
    // an HTTP failure/timeout means Azure performed no billable work.
    let cost=maximum;
    let settlementKind:"usage"|"maximum"|"rejected-input"="maximum";
    let boundError:EvidenceBudgetError|undefined;
    let response:Response;
    try {
      signal?.throwIfAborted();
      response=await transport(input,{...requestInit,body:JSON.stringify(body)});
      if(response.ok) {
        try {
          const reported=usageCost(await response.clone().json(),price,inputBound,outputBound);
          if(reported!==null){cost=reported;settlementKind="usage";}
        }
        catch(error) {
          if(error instanceof EvidenceBudgetError)boundError=error;
          // Keep the conservative maximum if parsing/usage is unavailable.
        }
      } else if(response.status===400 && price.kind!=="embeddings") {
        // A prompt rejected by Azure's content filter has no generated output.
        // Charge its bounded input at the ceiling without converting the whole
        // output/context reservation into an imaginary model completion.
        try {
          if(isEvidenceContentFilter(await response.clone().json())) {
            cost=tokenCostMicros(inputBound,price.inputUsdPerMillion)
              +(price.kind==="router"?tokenCostMicros(inputBound,price.routerFeeUsdPerMillion!):0);
            settlementKind="rejected-input";
          }
        } catch { /* An unparseable error retains the full reservation. */ }
      }
    } catch(error) {
      try {await budget.settle(selection,reservation,maximum,"maximum");} catch { /* The outstanding reservation still holds its full cost. */ }
      throw error;
    }
    try {
      if(boundError)await budget.block(selection);
      await budget.settle(selection,reservation,cost,settlementKind);
    }
    catch(error){return blocked(error);}
    if(boundError)return blocked(boundError);
    return response;
  };
}
