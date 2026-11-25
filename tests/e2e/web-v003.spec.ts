import { expect, test, type Page } from '@playwright/test';
import { openWorkspace } from './workspace';

async function createCompletedFileTask(page:Page):Promise<{projectId:string;taskId:string;projectName:string}>{
  await page.request.get('/api/session');
  const projectName=`v003 证据搜索 ${Date.now()}`;
  const projectResponse=await page.request.post('/api/projects',{data:{name:projectName,kind:'software',authorizationConfirmed:true}});
  expect(projectResponse.ok(),await projectResponse.text()).toBe(true);
  const project=await projectResponse.json() as {id:string};
  const upload=await page.request.post(`/api/projects/${project.id}/uploads`,{multipart:{file:{name:'v003-search.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({name:'evidence-search-fixture',version:'1.0.0'}))}}});
  expect(upload.ok(),await upload.text()).toBe(true);
  const taskResponse=await page.request.post(`/api/projects/${project.id}/tasks`,{data:{adapter:'file'}});
  expect(taskResponse.ok(),await taskResponse.text()).toBe(true);
  const task=await taskResponse.json() as {id:string;status:string;error?:string};
  await expect.poll(async()=>{
    const response=await page.request.get(`/api/tasks/${task.id}`);
    const detail=await response.json() as {status:string;error?:string};
    return detail.status;
  },{timeout:90000,intervals:[500,1000,2000]}).toMatch(/COMPLETED|FAILED|BLOCKED|CANCELLED/);
  const finalResponse=await page.request.get(`/api/tasks/${task.id}`);
  const final=await finalResponse.json() as {status:string;error?:string};
  expect(final.status,final.error??JSON.stringify(final)).toBe('COMPLETED');
  return {projectId:project.id,taskId:task.id,projectName};
}

test('global evidence search returns cross-task evidence and opens the task',async({page})=>{
  const fixture=await createCompletedFileTask(page);
  await openWorkspace(page,'/evidence');
  await expect(page.getByRole('heading',{name:'证据探索器'})).toBeVisible();
  await expect(page.getByText('不指定任务时搜索所有任务的持久化证据。')).toBeVisible();
  await page.getByLabel('全局证据搜索').fill('Input identity');
  await page.getByLabel('证据类型').selectOption('EVIDENCE');
  await page.getByLabel('搜索项目').selectOption({label:fixture.projectName});
  await page.getByRole('button',{name:'搜索证据'}).click();
  const resultRow=page.getByRole('row').filter({hasText:'Input identity verified'});
  await expect(resultRow.getByRole('button',{name:'Input identity verified'})).toBeVisible();
  await expect(resultRow.getByText(fixture.projectName,{exact:true})).toBeVisible();
  await expect(resultRow.getByText('file',{exact:true})).toBeVisible();
  await resultRow.getByRole('link',{name:/进入任务证据/}).click();
  await expect(page).toHaveURL(new RegExp(`/evidence/${fixture.taskId}\\?evidence=`));
  await expect(page.getByRole('button',{name:'Input identity verified'})).toBeVisible();
});

test('backup center exposes real creation confirmation and isolated preview',async({page})=>{
  await openWorkspace(page,'/operations/backups');
  await expect(page.getByRole('heading',{name:'备份中心'})).toBeVisible();
  await expect(page.getByText('恢复只写入服务端自动分配的隔离目录')).toBeVisible();
  await page.getByRole('button',{name:'创建备份'}).click();
  await expect(page.getByText('确认创建当前数据库备份？')).toBeVisible();
  await page.getByRole('button',{name:'确认创建'}).click();
  await expect(page.getByText('备份创建成功，已写入服务端备份目录。')).toBeVisible();
  const response=await page.request.get('/api/backups');
  expect(response.ok(),await response.text()).toBe(true);
  const backups=await response.json() as {id:string;status:string}[];
  expect(backups.length).toBeGreaterThan(0);
  const backup=backups[0]!;
  const card=page.locator('section').filter({hasText:backup.id});
  await expect(card).toBeVisible();
  await card.getByRole('button',{name:'验证'}).click();
  await expect(page.getByText('备份完整性与 SQLite 校验通过。')).toBeVisible();
  await card.getByRole('button',{name:'隔离预览'}).click();
  await expect(page.getByRole('heading',{name:/隔离预览/})).toBeVisible();
  await expect(page.getByText('当前库保持不变；恢复仅生成可独立检查的数据库副本。')).toBeVisible();
  await card.getByRole('button',{name:'恢复到隔离目录'}).click();
  await expect(page.getByText('确认执行隔离恢复？服务端会分配新的隔离目录，不会替换当前库。')).toBeVisible();
});
