import { ButtonLink, EmptyState, PageHeader } from '../../components/ui';

export function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader title="Página não encontrada" />
      <EmptyState title="Este endereço não existe no Rotinas" action={<ButtonLink to="/" variant="primary">Ir para Hoje</ButtonLink>}>
        <p>O link pode estar incompleto ou apontar para algo que foi excluído.</p>
      </EmptyState>
    </div>
  );
}
