/**
 * Zero-dependency structural validator. Its whole purpose is to give agents a precise, machine-readable
 * reason for a rejection (`fieldErrors`) so they can fix the payload and retry instead of guessing.
 * Unknown keys are rejected by default: a typo like `serverity` must fail loudly, not be silently dropped.
 */
export type FieldError={path:string,code:string,message:string,expected?:string};

export class ValidationError extends Error {
  readonly code='VALIDATION_FAILED';
  constructor(readonly fieldErrors:FieldError[]){super(`Invalid request: ${fieldErrors.map(e=>`${e.path} ${e.code}`).join(', ')}`)}
}

type Ctx={path:string,errors:FieldError[]};
export type Validator<T>={parse(value:unknown,ctx:Ctx):T,optional?:true,fallback?:()=>unknown};

const fail=(ctx:Ctx,code:string,message:string,expected?:string)=>{ctx.errors.push({path:ctx.path||'(root)',code,message,...(expected?{expected}:{})})};
const child=(ctx:Ctx,key:string|number):Ctx=>({path:typeof key==='number'?`${ctx.path}[${key}]`:ctx.path?`${ctx.path}.${key}`:key,errors:ctx.errors});

export type StringOptions={min?:number,max?:number,pattern?:RegExp,trim?:boolean};
export const str=(options:StringOptions={}):Validator<string>=>({parse(value,ctx){
  if(typeof value!=='string'){fail(ctx,'NOT_A_STRING','Expected a string','string');return ''}
  const text=options.trim===false?value:value.trim();
  const min=options.min??1,max=options.max??4000;
  if(text.length<min)fail(ctx,'TOO_SHORT',`Expected at least ${min} characters, received ${text.length}`,`length >= ${min}`);
  if(text.length>max)fail(ctx,'TOO_LONG',`Expected at most ${max} characters, received ${text.length}`,`length <= ${max}`);
  if(options.pattern&&!options.pattern.test(text))fail(ctx,'PATTERN_MISMATCH',`Expected a value matching ${options.pattern}`,String(options.pattern));
  return text;
}});

export type NumberOptions={min?:number,max?:number,integer?:boolean,step?:number};
export const num=(options:NumberOptions={}):Validator<number>=>({parse(value,ctx){
  const parsed=typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN;
  if(!Number.isFinite(parsed)){fail(ctx,'NOT_A_NUMBER','Expected a finite number','number');return 0}
  if(options.integer&&!Number.isInteger(parsed))fail(ctx,'NOT_AN_INTEGER','Expected an integer','integer');
  if(options.min!==undefined&&parsed<options.min)fail(ctx,'TOO_SMALL',`Expected a value >= ${options.min}`,`>= ${options.min}`);
  if(options.max!==undefined&&parsed>options.max)fail(ctx,'TOO_LARGE',`Expected a value <= ${options.max}`,`<= ${options.max}`);
  // Floating point: 6.5 / 0.5 must be treated as an exact multiple, so compare against a rounded quotient.
  if(options.step){const quotient=parsed/options.step;if(Math.abs(quotient-Math.round(quotient))>1e-9)fail(ctx,'NOT_A_MULTIPLE',`Expected a multiple of ${options.step}`,`multiple of ${options.step}`)}
  return parsed;
}});

export const bool=():Validator<boolean>=>({parse(value,ctx){if(typeof value!=='boolean'){fail(ctx,'NOT_A_BOOLEAN','Expected true or false','boolean');return false}return value}});

export const oneOf=<T extends string>(values:readonly T[]):Validator<T>=>({parse(value,ctx){
  if(typeof value!=='string'||!values.includes(value as T)){fail(ctx,'NOT_ALLOWED',`Expected one of: ${values.join(', ')}`,values.join('|'));return values[0]}
  return value as T;
}});

export type ArrayOptions={min?:number,max?:number};
export const arr=<T>(item:Validator<T>,options:ArrayOptions={}):Validator<T[]>=>({parse(value,ctx){
  if(!Array.isArray(value)){fail(ctx,'NOT_AN_ARRAY','Expected an array','array');return []}
  const min=options.min??0,max=options.max??200;
  if(value.length<min)fail(ctx,'TOO_FEW_ITEMS',`Expected at least ${min} items, received ${value.length}`,`length >= ${min}`);
  if(value.length>max){fail(ctx,'TOO_MANY_ITEMS',`Expected at most ${max} items, received ${value.length}`,`length <= ${max}`);return []}
  return value.map((entry,index)=>item.parse(entry,child(ctx,index)));
}});

type Shape=Record<string,Validator<any>>;
type Infer<S extends Shape>={[K in keyof S]:S[K] extends Validator<infer T>?T:never};
export type ObjectOptions={allowUnknown?:boolean};
export const obj=<S extends Shape>(shape:S,options:ObjectOptions={}):Validator<Infer<S>>=>({parse(value,ctx){
  if(!value||typeof value!=='object'||Array.isArray(value)){fail(ctx,'NOT_AN_OBJECT','Expected an object','object');return {} as Infer<S>}
  const source=value as Record<string,unknown>,result:Record<string,unknown>={};
  for(const [key,validator] of Object.entries(shape)){
    const entry=source[key];
    if(entry===undefined||entry===null){
      if(validator.optional){if(validator.fallback)result[key]=validator.fallback();continue}
      fail(child(ctx,key),'REQUIRED','This field is required');continue;
    }
    result[key]=validator.parse(entry,child(ctx,key));
  }
  if(!options.allowUnknown)for(const key of Object.keys(source))if(!(key in shape))fail(child(ctx,key),'UNKNOWN_FIELD',`Unknown field. Allowed fields: ${Object.keys(shape).join(', ')}`);
  return result as Infer<S>;
}});

/**
 * Cross-field rule on top of a structurally valid value. Field-by-field checks cannot catch
 * `{min:10,max:1}`: every field is in range, yet the combination is unusable.
 * The check only runs when the inner validator produced no errors, so it never reports on garbage.
 */
export const refine=<T>(inner:Validator<T>,check:(value:T)=>FieldError[]|undefined):Validator<T>=>({parse(value,ctx){
  const before=ctx.errors.length,result=inner.parse(value,ctx);
  if(ctx.errors.length>before)return result;
  for(const error of check(result)??[])ctx.errors.push({...error,path:ctx.path?`${ctx.path}.${error.path}`:error.path});
  return result;
}});

export const optional=<T>(inner:Validator<T>):Validator<T|undefined>=>({parse:(value,ctx)=>inner.parse(value,ctx),optional:true});
export const withDefault=<T>(inner:Validator<T>,fallback:()=>T):Validator<T>=>({parse:(value,ctx)=>inner.parse(value,ctx),optional:true,fallback});
/** Accepts any JSON value. Used for opaque payloads the hub stores but never interprets. */
export const anyJson=(maxBytes=64*1024):Validator<unknown>=>({parse(value,ctx){
  let size=0;try{size=JSON.stringify(value)?.length??0}catch{fail(ctx,'NOT_SERIALIZABLE','Expected JSON-serializable data');return null}
  if(size>maxBytes)fail(ctx,'TOO_LARGE',`Expected at most ${maxBytes} serialized bytes, received ${size}`);
  return value;
}});

export function parse<T>(validator:Validator<T>,value:unknown):T{
  const errors:FieldError[]=[],result=validator.parse(value,{path:'',errors});
  if(errors.length)throw new ValidationError(errors.slice(0,50));
  return result;
}
