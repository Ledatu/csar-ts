import { afterEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError } from "axios";
import { createCsarClient } from "../../src/client.js";
import { withCsarFetchAsync } from "../../src/adapters/fetch.js";
import { applyCsarAxiosAsync } from "../../src/adapters/axios.js";
import { generateTestKey } from "./fixtures.js";
afterEach(() => vi.restoreAllMocks());
describe("explicit no401replay", () => {
  for (const adapter of ["client", "fetch", "axios"] as const) {
    it(`${adapter}: a monetary POST is sent once and the next independent call refreshes auth`, async () => {
      const key=await generateTestKey("ED25519");
      let sts=0, sent=0;
      const transport=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        if(String(input).includes("/sts/token")){
          sts++;return Response.json({access_token:`token-${sts}`,token_type:"Bearer",expires_in:300});
        }
        sent++;expect(init?.method?.toUpperCase()).toBe("POST");
        return new Response("original401",{status:401});
      });
      const config={maxWaitMs:0,maxRetries:0,auth:{keyData:key,stsEndpoint:"https://fixture/sts/token",retryUnauthorized:false}};
      let invoke:()=>Promise<unknown>;
      if(adapter==="client"){
        const client=await createCsarClient({...config,baseUrl:"https://fixture",fetch:transport});
        invoke=async()=>{const response=await client.post("/deposit","amount=1000");expect(response.status).toBe(401);expect(await response.text()).toBe("original401");};
      }else if(adapter==="fetch"){
        const wrapped=await withCsarFetchAsync(transport,config);
        invoke=async()=>{const response=await wrapped("https://fixture/deposit",{method:"POST",body:"amount=1000"});expect(response.status).toBe(401);expect(await response.text()).toBe("original401");};
      }else{
        vi.spyOn(globalThis,"fetch").mockImplementation(transport);
        const client=axios.create();
        client.defaults.adapter=async request=>{
          sent++;throw new AxiosError("unauthorized","ERR_BAD_REQUEST",request,undefined,{status:401,statusText:"Unauthorized",headers:{},config:request,data:"original401"});
        };
        await applyCsarAxiosAsync(client,config);
        invoke=async()=>{await expect(client.post("https://fixture/deposit","amount=1000")).rejects.toMatchObject({response:{status:401,data:"original401"}});};
      }
      await invoke();expect(sent).toBe(1);expect(sts).toBe(1);
      await invoke();expect(sent).toBe(2);expect(sts).toBe(2);
    });
  }
});
