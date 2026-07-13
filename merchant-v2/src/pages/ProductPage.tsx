import { useState } from 'react';
import { Bold, ImagePlus, Italic, Link2, LockKeyhole, Trash2, Underline } from 'lucide-react';
import { BlockedButton, FieldHelp, PageHeader } from '../components/ui';

export function ProductPage() {
  const [title, setTitle] = useState('');

  function formatDetail(command: 'bold' | 'italic' | 'underline') {
    document.execCommand(command);
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={<div className="header-status locked"><LockKeyhole aria-hidden="true" size={16} /> 写入已锁定</div>}
        description="每个店铺仅维护一个商品位，不提供商品列表。"
        eyebrow="02 / 商品与库存"
        title="单品提报"
      />
      <div className="lock-notice" role="alert">
        <LockKeyhole aria-hidden="true" size={20} />
        <div><strong>无法确认商品状态，已按最严格规则锁定</strong><p>该单品已被平台秒杀锁定，在场次截止前无权篡改数据。仅当 Core 的 `allowedActions` 明确允许编辑时解锁。</p></div>
      </div>
      <form className="form-layout" onSubmit={(event) => event.preventDefault()}>
        <section className="section-block form-section" aria-labelledby="basic-title">
          <div className="section-heading"><div><p className="eyebrow">Basic</p><h2 id="basic-title">基本信息</h2></div><span>唯一商品位</span></div>
          <div className="field">
            <label htmlFor="product-title">商品标题</label>
            <input id="product-title" maxLength={60} onChange={(event) => setTitle(event.target.value)} placeholder="输入不超过 60 个字的商品标题" type="text" value={title} />
            <FieldHelp>{title.length} / 60</FieldHelp>
          </div>
          <fieldset className="field">
            <legend>商品主图</legend>
            <div className="upload-grid">
              <button className="upload-tile" disabled type="button"><ImagePlus aria-hidden="true" size={22} /><span>上传图片</span><small>最多 5 张</small></button>
              <div className="upload-placeholder">签名上传元数据未发布</div>
            </div>
            <FieldHelp>支持 JPG、PNG、WebP；当前仅可查看界面，不能提交本地文件。</FieldHelp>
          </fieldset>
          <div className="field">
            <span className="field-label" id="product-detail-label">商品详情</span>
            <div className="editor-shell">
              <div className="editor-toolbar" aria-label="富文本格式">
                <button aria-label="加粗" className="icon-button" onMouseDown={(event) => { event.preventDefault(); formatDetail('bold'); }} type="button"><Bold aria-hidden="true" size={17} /></button>
                <button aria-label="斜体" className="icon-button" onMouseDown={(event) => { event.preventDefault(); formatDetail('italic'); }} type="button"><Italic aria-hidden="true" size={17} /></button>
                <button aria-label="下划线" className="icon-button" onMouseDown={(event) => { event.preventDefault(); formatDetail('underline'); }} type="button"><Underline aria-hidden="true" size={17} /></button>
                <button aria-label="插入链接（Core 富文本规则未发布）" className="icon-button" disabled type="button"><Link2 aria-hidden="true" size={17} /></button>
              </div>
              <div aria-labelledby="product-detail-label" aria-multiline="true" className="rich-editor" contentEditable data-placeholder="描述商品材质、规格、使用与履约说明" role="textbox" suppressContentEditableWarning />
            </div>
          </div>
        </section>

        <section className="section-block form-section" aria-labelledby="sku-title">
          <div className="section-heading"><div><p className="eyebrow">SKU & Inventory</p><h2 id="sku-title">规格与库存</h2></div></div>
          <div className="two-column-fields">
            <div className="field"><label htmlFor="sku-name">规格名称</label><input id="sku-name" placeholder="例如：标准款 / 金色" type="text" /></div>
            <div className="field"><label htmlFor="settlement-price">结算价</label><div className="input-suffix"><input disabled id="settlement-price" inputMode="decimal" placeholder="由 Core 提供精确金额字段" type="text" /><span>USDT</span></div><FieldHelp>前端不解析或换算原子单位。</FieldHelp></div>
          </div>
          <div className="field"><label htmlFor="seckill-inventory">秒杀专属库存</label><input disabled id="seckill-inventory" inputMode="numeric" min="1" placeholder="正整数，一次性提报" type="number" /><FieldHelp>提交后不可由商家增改。</FieldHelp></div>
          <fieldset className="field">
            <legend>支持履约模式</legend>
            <div className="choice-row">
              <label><input disabled type="checkbox" /> 快递邮寄</label>
              <label><input disabled type="checkbox" /> 到店自提</label>
            </div>
          </fieldset>
          <div className="form-actions">
            <button className="button danger-quiet" disabled type="button"><Trash2 aria-hidden="true" size={16} /> 清空并上新</button>
            <button className="button secondary" disabled type="button">下架</button>
            <BlockedButton>保存提报</BlockedButton>
          </div>
        </section>
      </form>
    </div>
  );
}
